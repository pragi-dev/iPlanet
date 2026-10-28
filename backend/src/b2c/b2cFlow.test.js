// End-to-end tests for the B2C email-to-ticket workflow over HTTP, using the
// test email and CRM adapters and a real MongoDB. Each run uses a new,
// uniquely named database that is dropped afterwards; set
// B2C_TEST_MONGODB_URI to point at a different server. The suite is skipped
// when MongoDB is not reachable.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Customer, Device, Notification, User } from '../models.js';
import { auth, restrictB2COnlyStaff } from '../middleware.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { runStaffCommand, StaffCommandError } from './b2cStaff.js';
import { b2cModels, ensureB2CIndexes } from './b2cModels.js';
import { createB2CService } from './b2cService.js';
import { createB2CRouter } from './b2cRoutes.js';
import { createTestEmailAdapter } from './connectors/testEmailAdapter.js';
import { createTestCrmAdapter } from './connectors/testCrmAdapter.js';
import { createCrmConnector } from './connectors/crmConnector.js';
import { createCustomerDirectory, createDeviceDirectory } from './index.js';
import { createEmailConnectors } from './connectors/emailConnector.js';
import { createAttachmentStore } from './attachments.js';
import { loadB2CConfig, loadImapConfig } from './b2cConfig.js';
import { createImapEmailAdapter } from './connectors/imapEmailAdapter.js';
import { DEFAULT_TEMPLATES } from './b2cDefaults.js';

const JWT_SECRET = 'b2c-flow-test-secret';
process.env.JWT_SECRET = JWT_SECRET;
const DB_NAME = `iplanet_b2c_test_${process.pid}_${Date.now()}`;
const INBOX = 'escalations@b2c-inbox.test';
const CUSTOMER_ONE = 'test.customer.one@example.test';
const CUSTOMER_TWO = 'test.customer.two@example.test';
// Not a registered customer.
const UNREGISTERED = 'test.unregistered@example.test';
const { B2CEscalation, B2CInboundEmail, B2COutboundEmail, B2CAuditEvent, B2CIntegrationStatus } = b2cModels;
const silent = { info() {}, warn() {}, error() {} };

let mongoAvailable = true;
try { await mongoose.connect(process.env.B2C_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017', { dbName: DB_NAME, serverSelectionTimeoutMS: 3000 }); } catch { mongoAvailable = false; }
const skip = mongoAvailable ? false : 'MongoDB is not reachable (set B2C_TEST_MONGODB_URI)';

let clock = Date.now();
const now = () => new Date(clock);
const advanceMinutes = minutes => { clock += minutes * 60_000; };
const attachmentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2c-attachments-'));
const emailAdapter = createTestEmailAdapter();
const crmAdapter = createTestCrmAdapter();
const IMAP_SECRET = 'mock-imap-password';
// Stands in for the MilesWeb IMAP mailbox: unread flags are kept in memory.
const imapServer = { messages: [] };
const imapClient = {
  usable: false, mailbox: null, connectError: null, on() {},
  async connect() { if (imapClient.connectError) throw imapClient.connectError; imapClient.usable = true; },
  async mailboxOpen(path) { imapClient.mailbox = { path, uidValidity: 9n }; },
  async search() { return imapServer.messages.filter(item => !item.seen).map(item => item.uid); },
  async fetchOne(uid, query) {
    const message = imapServer.messages.find(item => String(item.uid) === String(uid));
    return query.source ? { uid: message.uid, source: Buffer.from(message.source) } : { uid: message.uid, size: message.source.length, internalDate: now(), envelope: {} };
  },
  async messageFlagsAdd(uid) { imapServer.messages.find(item => String(item.uid) === String(uid)).seen = true; },
  async logout() { imapClient.usable = false; },
  close() { imapClient.usable = false; },
};
const imapMime = ({ from, subject, messageId, body, inReplyTo }) => `From: "Test Customer" <${from}>\r\nTo: sender@mock.test\r\nSubject: ${subject}\r\nMessage-ID: ${messageId}\r\n${inReplyTo ? `In-Reply-To: ${inReplyTo}\r\n` : ''}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
const imapConfig = loadImapConfig({ IMAP_HOST: 'mail.mock.test', IMAP_USER: 'sender@mock.test', IMAP_PASS: IMAP_SECRET });
const config = { ...loadB2CConfig({}), attachmentDir, crmProvider: 'test', pollMinutes: 0, imap: imapConfig };
const notifications = [];
// Mirrors server.js notifyUsers: one in-app Notification per recipient.
const notifyUsers = async notification => {
  notifications.push(notification);
  await Notification.insertMany(notification.users.map(user => ({ user: user._id, portalRole: user.role, type: notification.type, title: notification.title, message: notification.message, action: notification.action, read: false })));
};
const serviceOptions = { User, notifyUsers, deviceDirectory: createDeviceDirectory(Device), customerDirectory: createCustomerDirectory(Customer), emailConnectors: createEmailConnectors({ config, testAdapter: emailAdapter, imapAdapter: createImapEmailAdapter(imapConfig, { createClient: () => imapClient, idleCloseMs: 5 }) }), crmConnector: crmAdapter, attachmentStore: createAttachmentStore({ dir: attachmentDir }), logger: silent, now };
const service = createB2CService({ ...serviceOptions, models: b2cModels, config });

const users = {};
let server;
let baseUrl;
let sequence = 0;

const token = user => jwt.sign({ id: user._id, role: user.role, name: user.name }, JWT_SECRET);
async function api(user, method, url, body) {
  const response = await fetch(`${baseUrl}/api/b2c${url}`, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
// The default display name is no registered customer's name.
function sendEmail({ from = CUSTOMER_ONE, name = 'Test Customer', subject = '', body = '', headers = {}, attachments = [], internetMessageId, providerMessageId } = {}) {
  sequence += 1;
  return emailAdapter.inject(INBOX, { providerMessageId, internetMessageId: internetMessageId || `<message-${sequence}@client.test>`, from: { address: from, name }, to: [INBOX], subject, text: body, headers, attachments, receivedAt: now().toISOString() });
}
async function deliver(options, runner = service) {
  const providerMessageId = sendEmail(options);
  await runner.runCycle('test');
  return B2CInboundEmail.findOne({ dedupeKey: `test-inbox:${providerMessageId}` }).lean();
}
const ticketOf = inbound => B2CEscalation.findById(inbound.ticketId).lean();
const act = (user, ticket, action, body = {}) => api(user, 'POST', `/tickets/${ticket._id}/actions/${action}`, body);
const sent = () => emailAdapter.sentMessages();

before(async () => {
  if (!mongoAvailable) return;
  await ensureB2CIndexes();
  await User.createIndexes();
  // Level staff are B2C-only accounts; the admin is an iPlanet Service account that also holds a B2C role.
  const make = (name, b2cRole, extra = {}) => User.create({ name, email: `${name}@staff.test`, password: hashPassword('Test@123'), role: 'b2c_staff', b2cRole, ...extra });
  users.admin = await make('admin', 'b2c_admin', { role: 'iplanet_service' });
  // The only Cluster Manager covers North and West; nobody holds East.
  users.cm = await make('cluster', 'cluster_manager', { b2cRegions: ['Test Region North', 'Test Region West'] });
  // Revoked: still lists East, but holds no B2C role, so must never be assigned.
  users.formerEast = await make('former-east', null, { b2cRegions: ['Test Region East'] });
  users.rbh1 = await make('rbh-one', 'rbh');
  users.rbh2 = await make('rbh-two', 'rbh');
  users.trainer = await make('trainer', 'trainer');
  users.cd = await make('cd-am', 'cd_team_am');
  users.sel = await make('sel', 'service_excellence_lead');
  users.desk = await make('desk', null, { role: 'iplanet_service' });
  users.corporate = await User.create({ name: 'corp', email: 'corp@staff.test', password: hashPassword('Test@123'), role: 'corporate_admin' });
  const app = express();
  app.use(express.json());
  app.use('/api', restrictB2COnlyStaff);
  app.use('/api/b2c', createB2CRouter({ service, auth, User, Notification, logger: silent }));
  // Stands in for every B2B route, which B2C-only accounts must not reach.
  app.get('/api/coverage', auth, (_, res) => res.json({ devices: [] }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const settings = await api(users.admin, 'PUT', '/settings', { classificationRules: [{ category: 'Service', keywords: ['repair'], enabled: true }, { category: 'Retail', keywords: ['invoice', 'store'], enabled: true }] });
  assert.equal(settings.status, 200);
  // The portal's device records, each with its pre-defined region (`location`).
  await Device.createIndexes();
  await Device.insertMany([
    { serialNumber: 'TESTSERIAL01', model: 'Test Device Model A', location: 'Test Region North' },
    { serialNumber: 'TESTSERIAL02', model: 'Test Device Model B', location: ' Test  Region West ' },
    { serialNumber: 'DEVEAST001', model: 'Test Device Model C', location: 'Test Region East' },
    { serialNumber: 'DEVNOLOC01', model: 'Test Device Model C' },
    // The same serial number in two cases: two records, so it is not guessed.
    { serialNumber: 'DEVDUP0001', model: 'Test Device Model C', location: 'Test Region North' },
    { serialNumber: 'devdup0001', model: 'Test Device Model C', location: 'Test Region West' },
    // A device no customer is registered with.
    { serialNumber: 'UNOWNED001', model: 'Test Device Model A', location: 'Test Region North' },
  ]);
  // The registered customers: one record per purchase. Customer Five bought four devices;
  // the family address and name are on two records with different phone numbers (two people).
  await Customer.createIndexes();
  for (const record of [
    { name: 'Test Customer One', email: CUSTOMER_ONE, mobileNumber: '+919000000001', deviceSerialNumber: 'TESTSERIAL01' },
    { name: 'Test Customer Two', email: CUSTOMER_TWO, mobileNumber: '09000000002', deviceSerialNumber: 'TESTSERIAL02' },
    ...['DEVEAST001', 'DEVNOLOC01', 'DEVDUP0001', 'NOSUCHDEV01'].map(deviceSerialNumber => ({ name: 'Test Customer Five', email: 'test.customer.five@example.test', mobileNumber: '9000000005', deviceSerialNumber })),
    { name: 'Test Family Member', email: 'test.family@example.test', mobileNumber: '9000000011', deviceSerialNumber: 'FAMILY0001' },
    { name: 'Test Family Member', email: 'test.family@example.test', mobileNumber: '9000000012', deviceSerialNumber: 'FAMILY0002' },
  ]) await Customer.create(record);
});

after(async () => {
  server?.close();
  if (mongoAvailable) {
    assert.match(mongoose.connection.name, /^iplanet_b2c_test_/);
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
  fs.rmSync(attachmentDir, { recursive: true, force: true });
});

test('one email becomes one enriched, routed ticket; the acknowledgement waits for an approved template', { skip }, async () => {
  const inbound = await deliver({ subject: 'Repair taking too long', body: 'Hello,\nCase ID: TEST-CASE-0001\nSerial No: TESTSERIAL01\nThe repair of my phone is delayed.' });
  assert.equal(inbound.status, 'processed');
  assert.equal(inbound.outcome, 'ticket_created');
  let ticket = await ticketOf(inbound);
  assert.match(ticket.reference, /^B2C-\d{4}-000001$/);
  assert.equal(ticket.category, 'Service');
  assert.deepEqual(ticket.identifiers.map(item => [item.type, item.value]), [['caseId', 'TEST-CASE-0001'], ['serialNumber', 'TESTSERIAL01']]);
  assert.equal(ticket.crm.status, 'matched');
  assert.equal(ticket.customer.name, 'Test Customer One');
  assert.equal(ticket.devices[0].serialNumber, 'TESTSERIAL01');
  // The sender's address and the serial number are on the same registered customer record.
  assert.deepEqual([ticket.customerMatch.status, ticket.customerMatch.method, ticket.customerMatch.matchedBy, ticket.customerMatch.name], ['matched', 'serial_and_contact', ['email', 'serial'], 'Test Customer One']);
  assert.equal(ticket.customerMatch.customerIds.length, 1);
  // Routed by the region on that registered device's record.
  assert.equal(ticket.region, 'Test Region North');
  assert.deepEqual([ticket.regionAssignment.status, ticket.regionAssignment.source, ticket.regionAssignment.serialNumber, ticket.regionAssignment.model], ['automatic', 'device_location', 'TESTSERIAL01', 'Test Device Model A']);
  assert.ok(ticket.regionAssignment.deviceId);
  // The only Cluster Manager for North receives it directly.
  assert.equal(ticket.status, 'Engineer Assigned');
  assert.equal(ticket.workflow.currentLevel, 'cluster_manager');
  assert.equal(String(ticket.workflow.assignee.userId), String(users.cm._id));
  assert.ok(notifications.some(item => String(item.users[0]._id) === String(users.cm._id) && item.action.route.endsWith(String(ticket._id))));
  // Default templates are unapproved, so nothing is sent yet.
  assert.equal(ticket.acknowledgement.status, 'held');
  assert.equal(sent().length, 0);

  const approved = await api(users.admin, 'PUT', '/settings', { templates: DEFAULT_TEMPLATES.map(template => ({ ...template, approved: true })) });
  assert.equal(approved.status, 200);
  assert.ok(approved.body.templates.every(template => template.approved && template.approvedBy === 'admin'));
  await service.runCycle('test');
  ticket = await ticketOf(inbound);
  assert.equal(ticket.acknowledgement.status, 'sent');
  const [ack] = sent();
  assert.equal(ack.to, CUSTOMER_ONE);
  assert.equal(ack.from, INBOX);
  // The bracketed reference (anywhere in the subject) threads the customer's reply.
  assert.equal(ack.subject, `Support Request Received – Ticket [${ticket.reference}]`);
  assert.match(ack.text, new RegExp(ticket.reference));
  const actions = (await B2CAuditEvent.find({ ticketId: ticket._id }).sort({ at: 1 }).lean()).map(event => event.action);
  for (const action of ['created_from_email', 'crm_lookup', 'region_identified', 'routed', 'acknowledgement_queued', 'email_sent']) assert.ok(actions.includes(action), action);
  // Every log entry also reaches the notification feed, naming the reference but not the customer.
  const feed = await Notification.find({ user: users.admin._id, 'action.route': `/b2c/tickets/${ticket._id}` }).lean();
  for (const title of ['Created from email', 'CRM lookup', 'Routed to workflow', 'Acknowledgement queued', 'Email sent']) assert.ok(feed.some(item => item.title === title), title);
  assert.ok(feed.every(item => item.message.includes(ticket.reference) && !item.message.includes(CUSTOMER_ONE)));
  // The Cluster Manager was told "New escalation" for the routing, not a second time.
  assert.equal(await Notification.countDocuments({ user: users.cm._id, 'action.route': `/b2c/tickets/${ticket._id}`, title: 'Routed to workflow' }), 0);
});

test('duplicate deliveries and reprocessing never create a second ticket or acknowledgement', { skip }, async () => {
  const tickets = await B2CEscalation.countDocuments();
  const acks = await B2COutboundEmail.countDocuments({ kind: 'acknowledgement' });
  // Same Message-ID arriving again (e.g. copied to another TCM inbox).
  const copy = await deliver({ subject: 'Repair taking too long', body: 'Case ID: TEST-CASE-0001', internetMessageId: '<message-1@client.test>' });
  assert.equal(copy, null, 'the duplicate is not stored');
  // The provider handing back a message it already delivered.
  const original = await B2CInboundEmail.findOne({ internetMessageId: '<message-1@client.test>' });
  const again = await service.ingestMessage({ key: 'test-inbox', address: INBOX, provider: 'test' }, { providerMessageId: original.providerMessageId, from: { address: CUSTOMER_ONE }, subject: 'x', text: 'y' });
  assert.equal(again.duplicate, true);
  // Processing the same stored email again resumes, it does not repeat.
  await service.processInbound(original);
  assert.equal(await B2CEscalation.countDocuments(), tickets);
  assert.equal(await B2COutboundEmail.countDocuments({ kind: 'acknowledgement' }), acks);
});

test('emails from an unregistered sender without an identifier go to the admin-only triage queue and are routed after triage', { skip }, async () => {
  const inbound = await deliver({ from: UNREGISTERED, subject: 'Store experience', body: 'The store staff did not help me.' });
  let ticket = await ticketOf(inbound);
  assert.equal(ticket.status, 'Pending Triage');
  assert.deepEqual(ticket.triage.reasons, ['missing_identifier', 'crm_no_match', 'customer_not_found']);
  assert.equal(ticket.category, 'Retail');
  assert.equal(ticket.acknowledgement.status, 'sent', 'the customer is still acknowledged');
  assert.equal((await api(users.cm, 'GET', `/tickets/${ticket._id}`)).status, 404);
  assert.equal((await act(users.cm, ticket, 'complete_triage', { category: 'Retail' })).status, 404);
  const queue = await api(users.admin, 'GET', '/tickets?status=Pending%20Triage');
  assert.ok(queue.body.items.some(item => item.reference === ticket.reference));
  const detail = await api(users.admin, 'GET', `/tickets/${ticket._id}`);
  assert.ok(detail.body.allowedActions.includes('complete_triage'));
  assert.equal((await act(users.admin, ticket, 'complete_triage', { category: 'Gadgets' })).status, 400);
  // A serial number added in triage finds the device, and its region is used even though
  // the sender is not its registered customer.
  const triaged = await act(users.admin, ticket, 'complete_triage', { category: 'Retail', identifiers: [{ type: 'serialNumber', value: 'testserial02' }] });
  assert.equal(triaged.status, 200);
  ticket = triaged.body.ticket;
  assert.equal(ticket.status, 'Engineer Assigned');
  // The serial number is not the sender's, so the CRM is not searched with it.
  assert.equal(ticket.crm.status, 'no_match');
  assert.ok(ticket.identifiers.some(item => item.value === 'TESTSERIAL02' && item.source === 'manual'));
  assert.deepEqual([ticket.region, ticket.regionAssignment.status, ticket.regionAssignment.ownerCheck, ticket.customerMatch.status], ['Test Region West', 'automatic', 'customer_not_matched', 'not_found']);
  assert.equal(String(ticket.workflow.assignee.userId), String(users.cm._id));
  assert.ok(triaged.body.audit.some(event => event.action === 'triage_completed' && event.details.overriddenReasons.includes('missing_identifier')));
});

test('an email matching both categories is not guessed', { skip }, async () => {
  const ticket = await ticketOf(await deliver({ subject: 'Repair invoice', body: 'Case ID: TEST-CASE-0001, Serial No: TESTSERIAL01 — the repair invoice is wrong.' }));
  assert.equal(ticket.category, 'Unclassified');
  assert.deepEqual(ticket.triage.reasons, ['ambiguous_category']);
});

test('saving classification rules completes triage for waiting tickets that now have a category and a region', { skip }, async () => {
  const rules = [{ category: 'Service', keywords: ['repair'], enabled: true }, { category: 'Retail', keywords: ['invoice', 'store'], enabled: true }];
  const inbound = await deliver({ from: CUSTOMER_TWO, subject: 'Gizmo fault', body: 'Serial No: TESTSERIAL02, the gizmo is faulty.' });
  let ticket = await ticketOf(inbound);
  assert.equal(ticket.status, 'Pending Triage');
  assert.deepEqual(ticket.triage.reasons, ['unclassified_category']);
  assert.equal(ticket.region, 'Test Region West');
  assert.equal((await api(users.admin, 'PUT', '/settings', { classificationRules: [{ ...rules[0], keywords: ['repair', 'gizmo'] }, rules[1]] })).status, 200);
  ticket = await ticketOf(inbound);
  assert.deepEqual([ticket.category, ticket.classification.source, ticket.status], ['Service', 'rule', 'Engineer Assigned']);
  assert.equal(String(ticket.workflow.assignee.userId), String(users.cm._id));
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'triage_completed', 'details.automatic': true }));
  await api(users.admin, 'PUT', '/settings', { classificationRules: rules });
});

test('a CRM outage does not hold a ticket with a category and region, and the lookup is retried with backoff', { skip }, async () => {
  crmAdapter.failNext(Object.assign(new Error('CRM returned HTTP 503'), { retryable: true }));
  const inbound = await deliver({ from: CUSTOMER_TWO, subject: 'Repair status', body: 'Case ID: TEST-CASE-0002, Serial No: TESTSERIAL02, repair pending.' });
  let ticket = await ticketOf(inbound);
  assert.equal(ticket.crm.status, 'error');
  // The region comes from the device records, so the CRM outage does not affect it, and
  // with the category known triage completes by itself.
  assert.deepEqual([ticket.regionAssignment.status, ticket.region], ['automatic', 'Test Region West']);
  assert.equal(ticket.status, 'Engineer Assigned');
  assert.deepEqual(ticket.triage.reasons, []);
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'triage_completed', 'details.automatic': true, 'details.overriddenReasons': 'crm_error' }));
  assert.ok(ticket.crm.nextAttemptAt);
  assert.equal((await B2CIntegrationStatus.findOne({ key: 'crm' }).lean()).consecutiveFailures, 1);
  await service.runCycle('test');
  assert.equal((await ticketOf(inbound)).crm.status, 'error', 'not retried before the backoff');
  advanceMinutes(2);
  await service.runCycle('test');
  ticket = await ticketOf(inbound);
  assert.equal(ticket.crm.status, 'matched');
  assert.equal(ticket.status, 'Engineer Assigned');
  assert.equal(ticket.customer.crmCustomerId, 'TEST-CUST-0002');
  assert.equal(ticket.region, 'Test Region West');
  assert.equal((await B2CIntegrationStatus.findOne({ key: 'crm' }).lean()).consecutiveFailures, 0);
});

test('auto-replies and mail from our own inboxes are ignored without acknowledgement', { skip }, async () => {
  const before = sent().length;
  const autoReply = await deliver({ subject: 'Out of office', body: 'Away', headers: { 'Auto-Submitted': 'auto-replied' } });
  assert.equal(autoReply.status, 'ignored');
  assert.equal(autoReply.outcome, 'ignored_auto_submitted');
  assert.equal(autoReply.ticketId, undefined);
  const loop = await deliver({ from: INBOX, subject: 'Loop', body: 'x' });
  assert.equal(loop.outcome, 'ignored_own_address');
  assert.equal(sent().length, before);
});

test('attachments: only safe files are stored and they download only for authorised staff', { skip }, async () => {
  const inbound = await deliver({ subject: 'Repair photos', body: 'Case ID: TEST-CASE-0001 Serial No: TESTSERIAL01', attachments: [
    { filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4 test invoice') },
    { filename: 'setup.exe', content: Buffer.from('MZ binary') },
    { filename: 'photo.png', content: Buffer.from('<html>not a png</html>') },
  ] });
  assert.deepEqual(inbound.attachments.map(item => [item.filename, item.status, item.rejectReason || null]), [['invoice.pdf', 'stored', null], ['setup.exe', 'rejected', 'type_not_allowed'], ['photo.png', 'rejected', 'content_does_not_match_type']]);
  const ticket = await ticketOf(inbound);
  const detail = await api(users.cm, 'GET', `/tickets/${ticket._id}`);
  assert.equal(detail.status, 200);
  const pdf = detail.body.conversation[0].attachments.find(item => item.filename === 'invoice.pdf');
  assert.match(pdf.downloadKey, /^[a-f0-9]{32}$/);
  const download = await api(users.cm, 'GET', `/tickets/${ticket._id}/attachments/${pdf.downloadKey}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.body.toString(), '%PDF-1.4 test invoice');
  assert.equal((await api(users.rbh1, 'GET', `/tickets/${ticket._id}/attachments/${pdf.downloadKey}`)).status, 404);
  assert.equal((await api(users.cm, 'GET', `/tickets/${ticket._id}/attachments/..%2F..%2Fsecret`)).status, 404);
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'attachment_downloaded' }));
});

test('access control: only B2C staff, admin-only areas, no data from other queues', { skip }, async () => {
  assert.equal((await api(null, 'GET', '/dashboard')).status, 401);
  assert.equal((await api(users.desk, 'GET', '/dashboard')).status, 403, 'B2B service desk without a B2C role');
  assert.equal((await api(users.corporate, 'GET', '/dashboard')).status, 403);
  for (const url of ['/settings', '/integrations/health', '/inbound', '/outbound', '/test-adapter/outbox']) assert.equal((await api(users.cm, 'GET', url)).status, 403, url);
  assert.equal((await api(users.cm, 'PUT', '/settings', { validation: { mode: 'none' } })).status, 403);
  const rbhQueue = await api(users.rbh1, 'GET', '/tickets');
  assert.equal(rbhQueue.status, 200);
  assert.equal(rbhQueue.body.total, 0, 'nothing has reached the RBH level yet');
  // B2C-only accounts are kept out of B2B data; B2B accounts are unaffected.
  assert.equal((await fetch(`${baseUrl}/api/coverage`, { headers: { Authorization: `Bearer ${token(users.cm)}` } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/coverage`, { headers: { Authorization: `Bearer ${token(users.desk)}` } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/coverage`, { headers: { Authorization: `Bearer ${token(users.corporate)}` } })).status, 200);
  // Notifications: own only, and they link to the B2C ticket page.
  const cmNotifications = await api(users.cm, 'GET', '/notifications');
  assert.ok(cmNotifications.body.length > 0);
  assert.ok(cmNotifications.body.every(item => String(item.user) === String(users.cm._id) && item.portalRole === 'b2c_staff' && item.action.route.startsWith('/b2c/tickets/')));
  assert.ok((await api(users.cm, 'GET', '/notifications/unread-count')).body.count > 0);
  assert.equal((await api(users.rbh1, 'PATCH', `/notifications/${cmNotifications.body[0]._id}/read`, {})).status, 404);
  assert.equal((await api(users.cm, 'PATCH', '/notifications/read-all', {})).status, 200);
  assert.equal((await api(users.cm, 'GET', '/notifications/unread-count')).body.count, 0);
  // Revoking the role takes effect without waiting for the token to expire.
  await User.updateOne({ _id: users.sel._id }, { b2cRole: null });
  assert.equal((await api(users.sel, 'GET', '/dashboard')).status, 403);
  await User.updateOne({ _id: users.sel._id }, { b2cRole: 'service_excellence_lead' });
});

test('full escalation: accept, start work, clarify, customer reply, reroute, claim, validate, reject, resolve, close, reopen', { skip }, async () => {
  const first = await B2CEscalation.findOne({ reference: /-000001$/ }).lean();
  const ref = first.reference;
  assert.equal((await act(users.rbh1, first, 'start')).status, 404, 'not visible to other levels');
  assert.equal((await act(users.cm, first, 'start')).status, 403, 'work starts only after the engineer accepts');
  assert.equal((await act(users.cm, first, 'accept')).body.ticket.status, 'Engineer Accepted');
  assert.equal((await act(users.cm, first, 'start')).body.ticket.status, 'In Progress');

  assert.equal((await act(users.cm, first, 'request_clarification', {})).status, 400);
  assert.equal((await act(users.cm, first, 'request_clarification', { message: 'Please share your service invoice.' })).body.ticket.status, 'Awaiting Customer');
  await service.runCycle('test');
  const clarification = sent().find(message => message.subject === `[${ref}] Additional information required`);
  assert.match(clarification.text, /Please share your service invoice\./);

  const reply = await deliver({ subject: `RE: [${ref}] Additional information required`, body: 'Invoice attached.' });
  assert.equal(reply.outcome, 'appended_to_ticket');
  assert.equal(String(reply.ticketId), String(first._id));
  assert.equal((await B2CEscalation.findById(first._id).lean()).status, 'In Progress');
  // Quoting the reference from another address starts a separate escalation.
  const stranger = await deliver({ from: 'someone.else@example.test', subject: `[${ref}] repair`, body: 'Case ID: TEST-CASE-0001' });
  assert.equal(stranger.outcome, 'ticket_created');
  assert.notEqual(String(stranger.ticketId), String(first._id));

  assert.equal((await act(users.cm, first, 'escalate', { reason: 'x' })).status, 404, 'no manual escalation; the SLA escalates');
  assert.equal((await act(users.cm, first, 'reroute', { levelKey: 'rbh' })).status, 400, 'a reason is required');
  const escalated = await act(users.cm, first, 'reroute', { levelKey: 'rbh', reason: 'Needs regional approval for goodwill replacement.' });
  assert.equal(escalated.body.ticket.workflow.currentLevel, 'rbh');
  assert.equal(escalated.body.ticket.status, 'Open', 'two RBHs: it waits in the RBH queue');
  assert.deepEqual(escalated.body.allowedActions, ['add_note'], 'the former assignee keeps read access only');
  const queue = await api(users.rbh2, 'GET', '/tickets?assignee=unassigned');
  assert.ok(queue.body.items.some(item => item.reference === ref));

  const claimed = (await act(users.rbh1, first, 'claim')).body.ticket;
  assert.equal(claimed.workflow.assignee.name, 'rbh-one');
  assert.equal(claimed.status, 'Engineer Accepted', 'taking ownership accepts the work');
  assert.equal((await act(users.rbh2, first, 'claim')).status, 403);
  await act(users.rbh1, first, 'start');
  assert.equal((await act(users.rbh1, first, 'propose_resolution', { resolutionSummary: 'Approved replacement.' })).status, 400);
  const proposed = await act(users.rbh1, first, 'propose_resolution', { resolutionSummary: 'Approved replacement unit.', customerMessage: 'We will replace your device this week.' });
  assert.equal(proposed.body.ticket.status, 'Pending Validation');
  assert.equal(proposed.body.ticket.validation.validatorLevel, 'trainer', 'validated by the next level on the path');
  assert.equal((await act(users.rbh1, first, 'approve_resolution')).status, 403, 'no self-validation');
  assert.equal((await act(users.cm, first, 'approve_resolution')).status, 403);
  assert.equal((await api(users.trainer, 'GET', `/tickets/${first._id}`)).status, 200);

  const rejected = await act(users.trainer, first, 'reject_resolution', { reason: 'Attach the RBH approval note.' });
  assert.equal(rejected.body.ticket.status, 'In Progress');
  await act(users.rbh1, first, 'propose_resolution', { resolutionSummary: 'Approved replacement unit (note attached).', customerMessage: 'We will replace your device this week.' });
  const approved = await act(users.trainer, first, 'approve_resolution', {});
  assert.equal(approved.body.ticket.status, 'Completed');
  await service.runCycle('test');
  const final = sent().find(message => message.subject === `[${ref}] Update on your concern`);
  assert.match(final.text, /We will replace your device this week\./);

  assert.equal((await act(users.rbh1, first, 'close')).body.ticket.status, 'Closed');
  assert.equal((await act(users.trainer, first, 'reopen', { reason: 'x' })).status, 403);
  const reopened = await act(users.admin, first, 'reopen', { reason: 'Customer reports the replacement has the same fault.' });
  assert.equal(reopened.body.ticket.status, 'Reopened');
  assert.equal(reopened.body.ticket.reopenCount, 1);

  const audit = reopened.body.audit.map(event => event.action);
  for (const action of ['accept', 'start', 'request_clarification', 'customer_replied', 'reroute', 'claim', 'propose_resolution', 'reject_resolution', 'approve_resolution', 'close', 'reopen']) assert.ok(audit.includes(action), action);
  assert.ok(reopened.body.audit.filter(event => event.actor?.role !== 'system').every(event => event.actor.name));
  assert.equal(reopened.body.conversation.filter(item => item.direction === 'inbound').length, 2);
});

test('SLA escalation follows the B2B rules: at risk, then breached and escalated up the path', { skip }, async () => {
  const rules = [{ level: 1, trigger: 'SLA Approaching', priority: 'All', slaThreshold: 80 }, { level: 2, trigger: 'SLA Breached', priority: 'All', slaThreshold: 100 }];
  const monitored = createB2CService({ ...serviceOptions, models: b2cModels, config, escalationRules: async () => rules });
  const inbound = await deliver({ subject: 'Repair SLA check', body: 'Case ID: TEST-CASE-0001\nSerial No: TESTSERIAL01\nStill waiting for the repair.' }, monitored);
  let ticket = await ticketOf(inbound);
  assert.deepEqual([ticket.priority, ticket.resolutionTarget, ticket.slaStatus], [undefined, '24 hours', 'Healthy'], 'no priority levels: one standard target');
  assert.equal((await act(users.cm, ticket, 'set_priority', { priority: 'High' })).status, 404);

  const age = hours => B2CEscalation.collection.updateOne({ _id: ticket._id }, { $set: { createdAt: new Date(now().getTime() - hours * 3600000), slaTargetAt: new Date(now().getTime() + (24 - hours) * 3600000) } });
  await age(20);
  await monitored.runCycle('test');
  ticket = await ticketOf(inbound);
  assert.deepEqual([ticket.slaStatus, ticket.escalationLevel, ticket.escalationStatus], ['At Risk', 1, 'At Risk']);
  assert.equal(String(ticket.workflow.assignee.userId), String(users.cm._id), 'the owner is unchanged, as for B2B tickets');

  notifications.length = 0;
  await age(25);
  await monitored.runCycle('test');
  await monitored.runCycle('test');
  ticket = await ticketOf(inbound);
  assert.deepEqual([ticket.slaStatus, ticket.escalationLevel, ticket.escalationStatus], ['SLA Breached', 2, 'Escalated']);
  const breach = notifications.filter(item => item.title === 'SLA breached');
  assert.equal(breach.length, 1, 'recorded and notified once');
  const told = breach[0].users.map(user => String(user._id));
  for (const person of [users.cm, users.rbh1, users.rbh2, users.admin]) assert.ok(told.includes(String(person._id)), 'owner, the next level and admins are notified');
  const audit = await B2CAuditEvent.find({ ticketId: ticket._id, action: 'sla_escalation' }).lean();
  assert.equal(audit.length, 2);
  assert.equal(audit[1].actor.name, 'SLA Monitor');
  assert.equal((await api(users.admin, 'GET', '/tickets?slaStatus=SLA%20Breached')).body.items.filter(item => item.reference === ticket.reference).length, 1);
});

test('processing failures are retried with backoff, parked after the limit and recoverable by an admin', { skip }, async () => {
  let failures = 2;
  const flakyCounter = { findOneAndUpdate: (...args) => { if (failures > 0) { failures -= 1; throw new Error('database hiccup'); } return b2cModels.B2CCounter.findOneAndUpdate(...args); } };
  const flaky = createB2CService({ ...serviceOptions, models: { ...b2cModels, B2CCounter: flakyCounter }, config });
  let inbound = await deliver({ subject: 'Repair again', body: 'Case ID: TEST-CASE-0001' }, flaky);
  assert.equal(inbound.status, 'retrying');
  assert.equal(inbound.attempts, 1);
  assert.match(inbound.lastError, /database hiccup/);
  await flaky.runCycle('test');
  assert.equal((await B2CInboundEmail.findById(inbound._id).lean()).attempts, 1, 'waits for its retry time');
  advanceMinutes(2);
  await flaky.runCycle('test');
  advanceMinutes(6);
  await flaky.runCycle('test');
  inbound = await B2CInboundEmail.findById(inbound._id).lean();
  assert.equal(inbound.status, 'processed');
  assert.equal(inbound.attempts, 3);

  failures = 99;
  const parked = createB2CService({ ...serviceOptions, models: { ...b2cModels, B2CCounter: flakyCounter }, config: { ...config, maxProcessingAttempts: 2 } });
  let stuck = await deliver({ subject: 'Repair once more', body: 'Case ID: TEST-CASE-0001' }, parked);
  advanceMinutes(2);
  await parked.runCycle('test');
  stuck = await B2CInboundEmail.findById(stuck._id).lean();
  assert.equal(stuck.status, 'failed');
  const failedList = await api(users.admin, 'GET', '/inbound?status=failed');
  assert.ok(failedList.body.some(item => String(item._id) === String(stuck._id)));
  const retried = await api(users.admin, 'POST', `/inbound/${stuck._id}/retry`);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.status, 'processed');
  assert.ok(retried.body.ticketId);
  assert.equal((await api(users.admin, 'POST', `/inbound/${stuck._id}/retry`)).status, 409);
});

test('a failed customer email send is retried and then delivered', { skip }, async () => {
  const original = emailAdapter.send;
  let failures = 1;
  emailAdapter.send = async (...args) => { if (failures > 0) { failures -= 1; throw Object.assign(new Error('Mail server unavailable'), { retryable: true }); } return original(...args); };
  try {
    const ticket = await ticketOf(await deliver({ subject: 'Repair query', body: 'Case ID: TEST-CASE-0001' }));
    const ack = await B2COutboundEmail.findById(ticket.acknowledgement.outboundId).lean();
    assert.equal(ack.status, 'retrying');
    assert.equal((await B2CIntegrationStatus.findOne({ key: 'outbound' }).lean()).consecutiveFailures, 1);
    advanceMinutes(2);
    await service.runCycle('test');
    assert.equal((await B2COutboundEmail.findById(ack._id).lean()).status, 'sent');
    assert.equal((await B2CEscalation.findById(ticket._id).lean()).acknowledgement.status, 'sent');
  } finally { emailAdapter.send = original; }
});

test('dashboard, reports, health and the test adapter endpoints', { skip }, async () => {
  const dashboard = await api(users.admin, 'GET', '/dashboard');
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.summary.active > 0);
  assert.ok(dashboard.body.summary.triage >= 1);
  assert.ok(dashboard.body.health);
  const cmDashboard = await api(users.cm, 'GET', '/dashboard');
  assert.equal(cmDashboard.body.health, undefined);
  assert.ok(cmDashboard.body.summary.active < dashboard.body.summary.active, 'a level user sees only their tickets');

  const reports = await api(users.admin, 'GET', '/reports');
  assert.equal(reports.status, 200);
  assert.ok(reports.body.byCategory.some(item => item.name === 'Service'));
  assert.ok(reports.body.byRegion.some(item => item.name === 'Test Region North'));
  assert.equal(reports.body.ageing.length, 5);
  assert.equal(reports.body.resolution.overall.count, 1);
  assert.equal(reports.body.monthly.length, 12);

  const health = await api(users.admin, 'GET', '/integrations/health');
  assert.equal(health.body.inboxes[0].mode, 'test');
  assert.equal(health.body.crm.mode, 'test');
  assert.deepEqual(health.body.testAdapters, { email: true, crm: true });
  assert.ok(health.body.queues.inbound.processed > 0);

  const injected = await api(users.admin, 'POST', '/test-adapter/inbound', { inboxKey: 'test-inbox', from: CUSTOMER_ONE, subject: 'Repair via test form', body: 'Case ID: TEST-CASE-0001' });
  assert.equal(injected.status, 200);
  assert.equal(injected.body.email.outcome, 'ticket_created');
  assert.match(injected.body.email.ticket.reference, /^B2C-/);
  const outbox = await api(users.admin, 'GET', '/test-adapter/outbox');
  assert.ok(outbox.body.some(message => message.subject.includes(`[${injected.body.email.ticket.reference}]`)));

  const search = await api(users.admin, 'GET', `/tickets?search=${encodeURIComponent('TESTSERIAL02')}&sort=reference&order=asc`);
  assert.ok(search.body.items.length >= 1);
  assert.equal((await api(users.admin, 'PUT', '/settings', { identifierRules: [{ key: 'bad', type: 'caseId', pattern: '([' }] })).status, 400);
});

test('staff provisioning: grant, revoke and list B2C roles; corporate accounts are refused', { skip }, async () => {
  const run = argv => runStaffCommand({ User, hashPassword, argv });
  const created = await run(['grant', '--email', 'New.Lead@Staff.test', '--role', 'service_excellence_lead', '--name', 'New Lead', '--regions', 'Test Region North, Test Region North']);
  const password = created.lines[1].split(': ').pop();
  const lead = await User.findOne({ email: 'new.lead@staff.test' }).select('+password').lean();
  assert.equal(lead.role, 'b2c_staff');
  assert.deepEqual(lead.b2cRegions, ['Test Region North']);
  assert.ok(verifyPassword(password, lead.password), 'the printed temporary password signs in');
  assert.equal((await api(lead, 'GET', '/me')).body.b2cRole, 'service_excellence_lead');

  // An existing Service account keeps its role and gains B2C access.
  await run(['grant', '--email', 'desk@staff.test', '--role', 'trainer']);
  const desk = await User.findOne({ email: 'desk@staff.test' }).lean();
  assert.equal(desk.role, 'iplanet_service');
  assert.equal((await api(desk, 'GET', '/me')).status, 200);

  await assert.rejects(run(['grant', '--email', 'corp@staff.test', '--role', 'b2c_admin']), StaffCommandError);
  await assert.rejects(run(['grant', '--email', 'x@staff.test', '--role', 'superuser', '--name', 'X']), StaffCommandError);
  await assert.rejects(run(['grant', '--email', 'nobody@staff.test', '--role', 'rbh']), /needs --name/);
  assert.ok((await run(['list'])).lines.some(line => line.startsWith('new.lead@staff.test\tservice_excellence_lead')));

  await run(['revoke', '--email', 'desk@staff.test']);
  assert.equal((await api(desk, 'GET', '/me')).status, 403, 'revocation applies to the existing session immediately');
  await run(['revoke', '--email', 'new.lead@staff.test']);
  assert.equal((await api(lead, 'GET', '/me')).status, 403);
});

// ---- Region from the device records ----------------------------------------------
const regionTickets = {};
const CUSTOMER_FIVE = 'test.customer.five@example.test';

test('the ticket goes to the region defined on the device with the email\'s serial number, not the customer\'s region', { skip }, async () => {
  // Customer Two's CRM region is South; the device record says West.
  const inbound = await deliver({ from: CUSTOMER_TWO, subject: 'Repair update', body: 'My phone, Serial No: testserial02, is still not repaired.' });
  const ticket = await ticketOf(inbound);
  regionTickets.west = ticket;
  assert.equal(ticket.region, 'Test Region West', 'taken from the device record, extra spaces removed');
  assert.deepEqual([ticket.regionAssignment.status, ticket.regionAssignment.source, ticket.regionAssignment.serialNumber, ticket.regionAssignment.model], ['automatic', 'device_location', 'TESTSERIAL02', 'Test Device Model B']);
  const device = await Device.findOne({ serialNumber: 'TESTSERIAL02' }).lean();
  assert.equal(String(ticket.regionAssignment.deviceId), String(device._id));
  assert.equal(ticket.customer.region, undefined, 'the customer region is not stored');
  assert.equal(ticket.status, 'Engineer Assigned');
  assert.equal(String(ticket.workflow.assignee.userId), String(users.cm._id));
  const identified = await B2CAuditEvent.findOne({ ticketId: ticket._id, action: 'region_identified' }).lean();
  assert.deepEqual(identified.details, { region: 'Test Region West', source: 'device_location', customerMatch: 'serial_and_contact', matchedBy: ['email', 'serial'], deviceId: String(device._id), ownerCheck: 'verified' });
  const routed = await B2CAuditEvent.findOne({ ticketId: ticket._id, action: 'routed' }).lean();
  assert.deepEqual([routed.details.region, routed.details.regionSource, routed.details.assignment], ['Test Region West', 'device_location', 'automatic']);
});

test('the region does not depend on the CRM or on B2C settings', { skip }, async () => {
  const offline = createB2CService({ ...serviceOptions, models: b2cModels, config, crmConnector: createCrmConnector({ config: { crmProvider: 'none' } }) });
  const ticket = await ticketOf(await deliver({ from: CUSTOMER_ONE, subject: 'Repair offline', body: 'Serial No: TESTSERIAL01' }, offline));
  assert.equal(ticket.crm.status, 'not_configured');
  assert.deepEqual([ticket.region, ticket.regionAssignment.status, ticket.status], ['Test Region North', 'automatic', 'Engineer Assigned']);
  const settings = await api(users.admin, 'GET', '/settings');
  assert.equal(settings.body.regions, undefined, 'no region list in settings');
});

test('missing or ambiguous device data goes to triage with the reason, never a guessed region', { skip }, async () => {
  // Customer Five is registered with all four of these devices.
  const cases = [
    ['device has no region', 'Serial No: DEVNOLOC01', 'device_region_missing'],
    ['serial number on two device records', 'Serial No: DEVDUP0001', 'multiple_device_matches'],
    ['serial number not in the device records', 'Serial No: NOSUCHDEV01', 'serial_not_found'],
    ['no serial number, several registered devices', 'Case ID: TEST-CASE-0001\nMobile: 9000000005', 'customer_device_ambiguous'],
    ['two serial numbers', 'Serial No: TESTSERIAL01 and Serial No: DEVEAST001', 'multiple_serial_numbers'],
  ];
  for (const [label, body, reason] of cases) {
    const ticket = await ticketOf(await deliver({ from: CUSTOMER_FIVE, subject: `Repair ${label}`, body }));
    regionTickets[reason] = ticket;
    assert.equal(ticket.status, 'Pending Triage', label);
    assert.ok(ticket.triage.reasons.includes(reason), `${label}: ${ticket.triage.reasons}`);
    assert.deepEqual([ticket.regionAssignment.status, ticket.regionAssignment.reason, ticket.region], ['unresolved', reason, ''], label);
    assert.equal(ticket.workflow.assignee, undefined, label);
    assert.equal((await api(users.cm, 'GET', `/tickets/${ticket._id}`)).status, 404, `${label}: only admins see triage`);
    assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'region_not_identified', 'details.reason': reason }), label);
  }
  // An email from an unregistered sender with no identifier at all.
  const bare = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Repair please', body: 'No details.' }));
  assert.deepEqual(bare.triage.reasons, ['missing_identifier', 'crm_no_match', 'customer_not_found']);
  assert.equal(bare.regionAssignment.reason, 'customer_not_found');
});

test('a failing device lookup is retried, not treated as "not found"', { skip }, async () => {
  let failures = 1;
  const flakyDevices = { ...createDeviceDirectory(Device), findBySerial: async serial => { if (failures-- > 0) throw new Error('database unavailable'); return createDeviceDirectory(Device).findBySerial(serial); } };
  const flaky = createB2CService({ ...serviceOptions, models: b2cModels, config, deviceDirectory: flakyDevices });
  let inbound = await deliver({ from: CUSTOMER_ONE, subject: 'Repair lookup', body: 'Serial No: TESTSERIAL01' }, flaky);
  assert.equal(inbound.status, 'retrying');
  assert.equal((await ticketOf(inbound)).regionAssignment.status, 'pending');
  advanceMinutes(2);
  await flaky.runCycle('test');
  inbound = await B2CInboundEmail.findById(inbound._id).lean();
  assert.equal(inbound.status, 'processed');
  const ticket = await ticketOf(inbound);
  assert.deepEqual([ticket.region, ticket.status], ['Test Region North', 'Engineer Assigned']);
  assert.equal(await B2CEscalation.countDocuments({ sourceEmailId: inbound._id }), 1);
});

test('a region with no active Cluster Manager is flagged for configuration, not assigned arbitrarily', { skip }, async () => {
  notifications.length = 0;
  const ticket = await ticketOf(await deliver({ from: CUSTOMER_FIVE, subject: 'Repair east', body: 'Serial No: DEVEAST001' }));
  regionTickets.east = ticket;
  assert.deepEqual([ticket.regionAssignment.status, ticket.region], ['automatic', 'Test Region East']);
  assert.equal(ticket.status, 'Pending Triage');
  assert.deepEqual(ticket.triage.reasons, ['no_regional_assignee']);
  assert.equal(ticket.workflow.assignee, undefined, 'the revoked East account is not used');
  assert.ok(notifications.some(item => item.title === 'Escalation needs triage' && item.users.some(user => String(user._id) === String(users.admin._id))));
});

test('manual review: only an admin, only a region defined on devices, a reason when overriding, and an eligible assignee', { skip }, async () => {
  const ticket = regionTickets.device_region_missing;
  const triage = body => act(users.admin, ticket, 'complete_triage', { category: 'Service', ...body });
  assert.equal((await act(users.cm, ticket, 'complete_triage', { category: 'Service', region: 'Test Region North', regionReason: 'x' })).status, 404);
  assert.match((await triage({})).body.message, /No device record gives/);
  assert.equal((await triage({ region: 'Atlantis', regionReason: 'x' })).status, 400, 'not a region on any device');
  assert.match((await triage({ region: 'Test Region North' })).body.message, /reason/);
  assert.equal((await triage({ region: 'Test Region North', regionReason: 'Confirmed with the customer', userId: String(users.rbh1._id) })).status, 400, 'not a Cluster Manager');
  assert.equal((await triage({ identifiers: [{ type: 'serialNumber', value: '<script>' }] })).status, 400, 'malformed serial');
  // Nothing was recorded by the refused attempts.
  assert.equal(await B2CAuditEvent.countDocuments({ ticketId: ticket._id, action: { $in: ['region_set', 'triage_completed'] } }), 0);

  const done = await triage({ region: 'test region north', regionReason: 'Confirmed with the customer', userId: String(users.cm._id) });
  assert.equal(done.status, 200);
  const result = done.body.ticket;
  assert.deepEqual([result.region, result.regionAssignment.status, result.regionAssignment.source, result.regionAssignment.decidedBy.name, result.regionAssignment.note], ['Test Region North', 'manual', 'manual', 'admin', 'Confirmed with the customer']);
  assert.equal(result.regionAssignment.serialNumber, 'DEVNOLOC01', 'the device found is kept');
  assert.deepEqual([result.status, String(result.workflow.assignee.userId)], ['Engineer Assigned', String(users.cm._id)]);
  const set = done.body.audit.find(event => event.action === 'region_set');
  assert.deepEqual([set.details.from, set.details.to, set.details.previousReason, set.actor.name, set.note], [null, 'Test Region North', 'device_region_missing', 'admin', 'Confirmed with the customer']);
  regionTickets.manual = result;

  // Overriding the device's region needs a reason too.
  const east = regionTickets.east;
  assert.match((await act(users.admin, east, 'complete_triage', { category: 'Service', region: 'Test Region North' })).body.message, /gives Test Region East/);
  // Confirming it does not; with nobody holding East it waits in the level queue.
  const confirmed = await act(users.admin, east, 'complete_triage', { category: 'Service', region: 'Test Region East' });
  assert.equal(confirmed.status, 200);
  assert.deepEqual([confirmed.body.ticket.regionAssignment.status, confirmed.body.ticket.status, confirmed.body.ticket.workflow.assignee ?? null], ['automatic', 'Open', null]);

  // A device added after the email arrived is found when an admin reviews the ticket.
  const later = regionTickets.serial_not_found;
  await Device.create({ serialNumber: 'NOSUCHDEV01', model: 'Test Device Model D', location: 'Test Region West' });
  const found = await act(users.admin, later, 'complete_triage', { category: 'Service' });
  assert.equal(found.status, 200);
  assert.deepEqual([found.body.ticket.region, found.body.ticket.regionAssignment.status], ['Test Region West', 'automatic']);
});

test('retries and reprocessing never overwrite a manual or progressed assignment', { skip }, async () => {
  const west = regionTickets.west;
  assert.equal((await act(users.admin, west, 'reroute', { levelKey: 'rbh', userId: String(users.rbh1._id), reason: 'Goodwill decision needed' })).status, 200);
  const manual = regionTickets.manual;
  assert.equal((await act(users.cm, manual, 'accept')).status, 200);
  // Even if the device record changes afterwards.
  await Device.updateOne({ serialNumber: 'TESTSERIAL02' }, { location: 'Test Region North' });
  const snapshot = async ticket => { const value = await B2CEscalation.findById(ticket._id).lean(); return JSON.stringify([value.region, value.regionAssignment, value.status, value.workflow]); };
  const before = [await snapshot(west), await snapshot(manual)];
  const routed = () => B2CAuditEvent.countDocuments({ action: 'routed', ticketId: { $in: [west._id, manual._id] } });
  const routedBefore = await routed();

  for (const ticket of [west, manual]) {
    await service.processInbound(await B2CInboundEmail.findById(ticket.sourceEmailId));
    assert.equal((await act(users.admin, ticket, 'retry_crm')).status, 200);
  }
  await service.runCycle('test');
  assert.deepEqual([await snapshot(west), await snapshot(manual)], before);
  assert.equal(await routed(), routedBefore);
  assert.equal(await B2CEscalation.countDocuments({ sourceEmailId: { $in: [west.sourceEmailId, manual.sourceEmailId] } }), 2, 'no duplicate tickets');
  await Device.updateOne({ serialNumber: 'TESTSERIAL02' }, { location: ' Test  Region West ' });
});

test('queue filters by region and region assignment status, within each user\'s visibility', { skip }, async () => {
  const refs = async (user, query) => (await api(user, 'GET', `/tickets?limit=100&${query}`)).body.items.map(item => item.reference);
  const unresolved = await refs(users.admin, 'regionStatus=unresolved');
  for (const reason of ['multiple_device_matches', 'multiple_serial_numbers']) assert.ok(unresolved.includes(regionTickets[reason].reference), reason);
  assert.ok(!unresolved.includes(regionTickets.west.reference));
  const manual = await refs(users.admin, 'regionStatus=manual');
  assert.ok(manual.includes(regionTickets.manual.reference) && !manual.includes(regionTickets.west.reference));
  assert.ok((await refs(users.admin, `region=${encodeURIComponent('Test Region West')}`)).includes(regionTickets.west.reference));
  const listed = (await api(users.admin, 'GET', '/tickets?regionStatus=unresolved')).body.items[0];
  assert.ok(listed.regionAssignment.reason, 'the queue shows why');
  assert.equal((await api(users.cm, 'GET', '/tickets?regionStatus=unresolved')).body.total, 0, 'triage stays admin-only');
  const detail = await api(users.admin, 'GET', `/tickets/${regionTickets.manual._id}`);
  assert.deepEqual(detail.body.workflow.regions, ['Test Region East', 'Test Region North', 'Test Region West'], 'the regions defined on devices');
  assert.equal(detail.body.workflow.firstLevel, 'cluster_manager');
});

// ---- Customer matching before the region ----------------------------------------------
// A customer is identified only when two independent details fit the same registered record.
const region = ticket => [ticket.customerMatch.status, ticket.regionAssignment.status, ticket.regionAssignment.reason ?? null, ticket.region];

test('no serial number: name and email identify the customer, whose only registered device gives the region', { skip }, async () => {
  const ticket = await ticketOf(await deliver({ from: CUSTOMER_TWO, name: 'test customer  two', subject: 'Repair still pending', body: 'Any update on my phone?' }));
  assert.deepEqual(region(ticket), ['matched', 'automatic', null, 'Test Region West']);
  assert.deepEqual([ticket.customerMatch.method, ticket.customerMatch.matchedBy], ['contact_details', ['name', 'email']]);
  assert.deepEqual([ticket.regionAssignment.serialNumber, ticket.regionAssignment.emailSerialNumber ?? null, ticket.regionAssignment.ownerCheck, ticket.status], ['TESTSERIAL02', null, 'verified', 'Engineer Assigned']);
  assert.equal(String(ticket.workflow.assignee.userId), String(users.cm._id));
  const identified = await B2CAuditEvent.findOne({ ticketId: ticket._id, action: 'region_identified' }).lean();
  assert.deepEqual([identified.details.customerMatch, identified.details.matchedBy, Boolean(identified.details.deviceId)], ['contact_details', ['name', 'email'], true]);
  assert.ok(!JSON.stringify(identified.details).includes(CUSTOMER_TWO), 'which details matched is recorded, never their values');
});

test('no serial number: name and phone, email and phone, or all three identify the customer; one detail alone does not', { skip }, async () => {
  // A relative writes from an unregistered address with Customer Two's name and number.
  const byPhone = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Repair for my father', body: 'Name: Test Customer Two\nHis mobile: +91 90000 00002.' }));
  assert.deepEqual([...region(byPhone), byPhone.customerMatch.matchedBy], ['matched', 'automatic', null, 'Test Region West', ['name', 'phone']]);
  assert.equal(byPhone.customer.email, UNREGISTERED, 'replies still go to the sender');
  const emailPhone = await ticketOf(await deliver({ from: CUSTOMER_TWO, subject: 'Repair', body: 'Mobile: 09000000002' }));
  assert.deepEqual([...region(emailPhone), emailPhone.customerMatch.matchedBy], ['matched', 'automatic', null, 'Test Region West', ['email', 'phone']]);
  const allThree = await ticketOf(await deliver({ from: CUSTOMER_TWO, name: 'Test Customer Two', subject: 'Repair', body: 'Mobile: 9000000002' }));
  assert.deepEqual([...region(allThree), allThree.customerMatch.matchedBy], ['matched', 'automatic', null, 'Test Region West', ['name', 'email', 'phone']]);
  // One detail each time. A name is never searched, so a name alone finds nobody.
  const single = [
    ['email only', { from: CUSTOMER_TWO, body: 'My phone is broken.' }, 'insufficient', 'customer_match_insufficient'],
    ['phone only', { from: UNREGISTERED, body: 'Mobile: 9000000002' }, 'insufficient', 'customer_match_insufficient'],
    ['name only', { from: UNREGISTERED, name: 'Test Customer Two', body: 'My phone is broken.' }, 'not_found', 'customer_not_found'],
  ];
  for (const [label, options, status, reason] of single) {
    const ticket = await ticketOf(await deliver({ subject: 'Repair', ...options }));
    assert.deepEqual(region(ticket), [status, 'unresolved', reason, ''], label);
    assert.deepEqual([ticket.status, ticket.customerMatch.customerIds, ticket.customerMatch.name ?? null], ['Pending Triage', [], null], label);
    assert.ok(ticket.triage.reasons.includes(reason), label);
  }
});

test('serial number present: it routes only after it is checked against the identified customer', { skip }, async () => {
  // A relative gives Customer Two's number and serial number: two details on the same record.
  const relative = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Repair for my father', body: 'His mobile: +91 90000 00002. Serial No: TESTSERIAL02' }));
  assert.deepEqual(region(relative), ['matched', 'automatic', null, 'Test Region West']);
  assert.deepEqual([relative.customerMatch.method, relative.customerMatch.matchedBy, relative.regionAssignment.ownerCheck], ['serial_and_contact', ['phone', 'serial'], 'verified']);
  // Customer One, identified by address and name, quotes Customer Two's serial number.
  const other = await ticketOf(await deliver({ from: CUSTOMER_ONE, name: 'Test Customer One', subject: 'Repair', body: 'Serial No: TESTSERIAL02' }));
  assert.deepEqual(region(other), ['matched', 'unresolved', 'serial_customer_conflict', '']);
  assert.deepEqual([other.regionAssignment.ownerCheck, other.status, other.customerMatch.name], ['other_customer', 'Pending Triage', 'Test Customer One']);
  const two = await Customer.findOne({ email: CUSTOMER_TWO }).lean();
  assert.ok(!other.customerMatch.customerIds.includes(two.customerId));
  const detail = JSON.stringify((await api(users.admin, 'GET', `/tickets/${other._id}`)).body.ticket);
  assert.ok(!detail.includes('Test Customer Two') && !detail.includes(CUSTOMER_TWO), 'the other customer is not disclosed');
  // A device on record that no customer is registered with.
  const unowned = await ticketOf(await deliver({ from: CUSTOMER_ONE, name: 'Test Customer One', subject: 'Repair', body: 'Serial No: UNOWNED001' }));
  assert.deepEqual([...region(unowned), unowned.regionAssignment.ownerCheck], ['matched', 'unresolved', 'serial_customer_conflict', '', 'not_registered']);
  // Only the sender's address, and someone else's serial number: they point to different people.
  const mixed = await ticketOf(await deliver({ from: CUSTOMER_ONE, subject: 'Repair', body: 'Serial No: TESTSERIAL02' }));
  assert.deepEqual(region(mixed), ['conflict', 'unresolved', 'customer_identifiers_conflict', '']);
  // A serial number on no device record is never trusted.
  const unknown = await ticketOf(await deliver({ from: CUSTOMER_ONE, name: 'Test Customer One', subject: 'Repair', body: 'Serial No: NOTADEVICE9' }));
  assert.deepEqual(region(unknown), ['matched', 'unresolved', 'serial_not_found', '']);
});

test('a serial number on a device record routes the ticket even when the sender is not a registered customer', { skip }, async () => {
  const ticket = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Repair', body: 'Serial No: TESTSERIAL01' }));
  assert.deepEqual(region(ticket), ['not_found', 'automatic', null, 'Test Region North']);
  assert.deepEqual([ticket.regionAssignment.ownerCheck, ticket.regionAssignment.serialNumber, ticket.regionAssignment.model, ticket.status], ['customer_not_matched', 'TESTSERIAL01', 'Test Device Model A', 'Engineer Assigned']);
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'region_identified', 'details.ownerCheck': 'customer_not_matched', 'details.customerMatch': 'not_found' }));
  // Without a serial number, an unregistered sender still goes to triage.
  const bare = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Repair', body: 'My phone is broken.' }));
  assert.deepEqual(region(bare), ['not_found', 'unresolved', 'customer_not_found', '']);
});

test('details pointing to different customers, or fitting several, go to triage without naming anyone', { skip }, async () => {
  // Two people share the family address and name; only their phone numbers differ. Both qualify,
  // even when one of their numbers is also given.
  for (const body of ['My phone is broken.', 'Mobile: 9000000011']) {
    const shared = await ticketOf(await deliver({ from: 'test.family@example.test', name: 'Test Family Member', subject: 'Repair', body }));
    assert.deepEqual(region(shared), ['ambiguous', 'unresolved', 'customer_ambiguous', ''], body);
    assert.deepEqual(shared.customerMatch.customerIds, []);
  }
  // The sender is Customer One but gives Customer Two's phone number.
  const conflict = await ticketOf(await deliver({ from: CUSTOMER_ONE, subject: 'Repair', body: 'Mobile: 09000000002. My phone is broken.' }));
  assert.deepEqual(region(conflict), ['conflict', 'unresolved', 'customer_identifiers_conflict', '']);
  assert.deepEqual([conflict.customerMatch.customerIds, conflict.customerMatch.name ?? null], [[], null], 'neither customer is recorded');
  // Customer One's address and name agree, but the phone number is Customer Two's.
  const contradicted = await ticketOf(await deliver({ from: CUSTOMER_ONE, name: 'Test Customer One', subject: 'Repair', body: 'Mobile: 09000000002' }));
  assert.deepEqual(region(contradicted), ['conflict', 'unresolved', 'customer_identifiers_conflict', '']);
  for (const ticket of [conflict, contradicted]) assert.equal((await api(users.cm, 'GET', `/tickets/${ticket._id}`)).status, 404, 'triage stays admin-only');
});

test('an identified customer without a device record, a purchase region or a regional assignee goes to triage', { skip }, async () => {
  await Device.insertMany([{ serialNumber: 'NOLOC00007', model: 'Test Device Model C' }, { serialNumber: 'EAST000008', model: 'Test Device Model C', location: 'Test Region East' }]);
  for (const [number, deviceSerialNumber] of [['Six', 'NODEVICE06'], ['Seven', 'NOLOC00007'], ['Eight', 'EAST000008']]) {
    await Customer.create({ name: `Test Customer ${number}`, email: `test.customer.${number.toLowerCase()}@example.test`, mobileNumber: `900000000${['Six', 'Seven', 'Eight'].indexOf(number) + 6}`, deviceSerialNumber });
  }
  const from = number => ({ from: `test.customer.${number.toLowerCase()}@example.test`, name: `Test Customer ${number}`, subject: 'Repair', body: 'My phone is broken.' });
  const noDevice = await ticketOf(await deliver(from('Six')));
  assert.deepEqual(region(noDevice), ['matched', 'unresolved', 'registered_device_not_found', '']);
  const noRegion = await ticketOf(await deliver(from('Seven')));
  assert.deepEqual([...region(noRegion), noRegion.regionAssignment.serialNumber], ['matched', 'unresolved', 'device_region_missing', '', 'NOLOC00007']);
  // The region is known, but nobody holds the first level there.
  const noAssignee = await ticketOf(await deliver(from('Eight')));
  assert.deepEqual(region(noAssignee), ['matched', 'automatic', null, 'Test Region East']);
  assert.deepEqual([noAssignee.status, noAssignee.triage.reasons, noAssignee.workflow.assignee ?? null], ['Pending Triage', ['no_regional_assignee'], null]);
  for (const ticket of [noDevice, noRegion, noAssignee]) assert.equal(ticket.status, 'Pending Triage');
});

test('a matched email delivered again or reprocessed keeps one ticket, and re-matching never resets its progress', { skip }, async () => {
  const email = { from: UNREGISTERED, subject: 'Repair', body: 'Name: Test Customer Two\nMobile: 9000000002', internetMessageId: '<name-phone-match@client.test>' };
  const inbound = await deliver(email);
  const ticket = await ticketOf(inbound);
  assert.deepEqual([ticket.customerMatch.status, ticket.status], ['matched', 'Engineer Assigned']);
  assert.equal((await act(users.cm, ticket, 'accept')).status, 200);
  const tickets = await B2CEscalation.countDocuments();
  assert.equal(await deliver(email), null, 'the duplicate is not stored');
  await service.processInbound(await B2CInboundEmail.findById(inbound._id));
  await service.runCycle('test');
  const after = await B2CEscalation.findById(ticket._id).lean();
  assert.equal(await B2CEscalation.countDocuments(), tickets, 'no second ticket');
  assert.deepEqual([after.status, after.region, String(after.workflow.assignee.userId), after.escalationStatus], ['Engineer Accepted', 'Test Region West', String(users.cm._id), ticket.escalationStatus]);
  for (const action of ['region_identified', 'routed', 'created_from_email']) assert.equal(await B2CAuditEvent.countDocuments({ ticketId: ticket._id, action }), 1, action);
});

test('customer and device details are visible only to B2C staff who can see the escalation', { skip }, async () => {
  const ticket = await B2CEscalation.findOne({ 'customerMatch.status': 'matched', 'workflow.assignee.userId': users.cm._id }).lean();
  assert.equal((await api(users.cm, 'GET', `/tickets/${ticket._id}`)).body.ticket.customerMatch.status, 'matched');
  for (const user of [users.corporate, users.desk]) assert.equal((await api(user, 'GET', `/tickets/${ticket._id}`)).status, 403);
  assert.equal((await api(users.rbh1, 'GET', `/tickets/${ticket._id}`)).status, 404, 'not visible to other levels');
  assert.equal((await api(null, 'GET', `/tickets/${ticket._id}`)).status, 401);
});

// ---- Acknowledgement from the separate company address (mocked SMTP sender) ----------------
const COMPANY_SENDER = 'noreply@company.test';
const ackOutbox = [];
const ackFailures = [];
// Stands in for connectors/smtpAckSender.js: records what would be sent; can fail on demand.
const mockAckSender = {
  provider: 'smtp', mode: 'live', enabled: true, fromEmail: COMPANY_SENDER,
  isConfigured: () => true, configCheck: () => ({ configured: true, missing: [] }), describeServer: () => ({ host: 'smtp.mock.test', port: 465, security: 'SSL/TLS', from: COMPANY_SENDER }),
  async send(message) {
    const failure = ackFailures.shift();
    if (failure) throw failure;
    ackOutbox.push({ ...message, from: COMPANY_SENDER });
    return { providerMessageId: `<smtp-${ackOutbox.length}@smtp.mock.test>`, responseCode: 250 };
  },
};
const ackConfig = policy => ({ ...config, ack: { ...config.ack, enabled: true, fromEmail: COMPANY_SENDER, companyName: 'Test Company', unmatchedPolicy: policy } });
const acking = createB2CService({ ...serviceOptions, models: b2cModels, config: ackConfig('verified'), ackSender: mockAckSender });
const ackOf = async ticket => B2COutboundEmail.find({ ticketId: ticket._id, kind: 'acknowledgement' }).lean();

test('acknowledgement: one email from the company address to the sender of a verified customer\'s email, with the stored ticket number', { skip }, async () => {
  const before = ackOutbox.length;
  // A relative writes from an unregistered address; Customer Two is matched by phone and serial number.
  const inbound = await deliver({ from: UNREGISTERED, subject: 'Phone not charging', body: 'For my father, mobile: +91 90000 00002. Serial No: TESTSERIAL02' }, acking);
  const ticket = await ticketOf(inbound);
  const [outbound, ...extra] = await ackOf(ticket);
  assert.equal(extra.length, 0, 'one acknowledgement job');
  assert.deepEqual([outbound.via, outbound.from, outbound.to, outbound.replyTo, outbound.status], ['company_sender', COMPANY_SENDER, UNREGISTERED, INBOX, 'sent']);
  assert.deepEqual([outbound.providerMessageId, outbound.responseCode], ['<smtp-' + (before + 1) + '@smtp.mock.test>', 250]);
  assert.deepEqual([ticket.acknowledgement.status, String(ticket.acknowledgement.outboundId)], ['sent', String(outbound._id)]);
  assert.ok(ticket.acknowledgement.sentAt);
  const message = ackOutbox.at(-1);
  assert.equal(ackOutbox.length, before + 1);
  assert.deepEqual([message.from, message.to, message.replyTo], [COMPANY_SENDER, UNREGISTERED, INBOX], 'sent to the address the email came from, not the registered one');
  assert.equal(message.subject, `Support Request Received – Ticket [${ticket.reference}]`);
  // The serial number the relative quoted is verified and repeated; the registered name is not disclosed to them.
  for (const line of [`Ticket Number: ${ticket.reference}`, 'Device Serial Number: TESTSERIAL02', 'Issue Summary: Phone not charging', 'Dear Test Customer,', 'Test Company Support Team']) assert.ok(message.text.includes(line), line);
  assert.doesNotMatch(message.text, /Test Customer Two|test\.customer\.two/);
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'email_sent', 'details.via': 'company_sender' }));

  // Reprocessing the same email and further cycles never queue or send a second one.
  await acking.processInbound(await B2CInboundEmail.findById(inbound._id));
  await acking.runCycle('test');
  assert.equal((await ackOf(ticket)).length, 1);
  assert.equal(await B2CEscalation.countDocuments({ sourceEmailId: inbound._id }), 1);
  assert.equal(ackOutbox.length, before + 1);
});

test('acknowledgement: the serial number line is left out when no verified serial number is known', { skip }, async () => {
  // Customer Five (address and phone number) has several devices and gives no serial number.
  const ticket = await ticketOf(await deliver({ from: CUSTOMER_FIVE, subject: 'Repair question', body: 'Is my repair done? Mobile: 9000000005' }, acking));
  const [outbound] = await ackOf(ticket);
  assert.equal(outbound.to, CUSTOMER_FIVE);
  assert.doesNotMatch(outbound.bodyText, /Serial Number|\{\{/);
  assert.match(outbound.bodyText, new RegExp(`Ticket Number: ${ticket.reference}`));
});

test('acknowledgement: a customer identified without a serial number is acknowledged at the address the email came from', { skip }, async () => {
  const before = ackOutbox.length;
  // Name and phone number in the message identify Customer Two; the sender is someone else.
  const ticket = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Screen flickers', body: 'Name: Test Customer Two\nMobile: 9000000002' }, acking));
  const [outbound, ...extra] = await ackOf(ticket);
  assert.equal(extra.length, 0);
  assert.deepEqual([outbound.to, outbound.status, ticket.acknowledgement.status], [UNREGISTERED, 'sent', 'sent']);
  const message = ackOutbox.at(-1);
  assert.ok(message.text.includes(`Ticket Number: ${ticket.reference}`));
  // The registered device's serial number was not in the email, so it is not sent to someone else.
  assert.doesNotMatch(message.text, /TESTSERIAL02|Serial Number/);
  // The customer writing from their own registered address gets their registered name and device.
  const own = await ticketOf(await deliver({ from: CUSTOMER_TWO, name: 'Test Customer Two', subject: 'Screen flickers', body: 'Any update?' }, acking));
  const [ownAck] = await ackOf(own);
  assert.equal(ownAck.to, CUSTOMER_TWO);
  for (const line of ['Device Serial Number: TESTSERIAL02', 'Dear Test Customer Two,']) assert.ok(ackOutbox.at(-1).text.includes(line), line);
  // A single detail identifies nobody, so nothing is sent under the default policy.
  const weak = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Screen flickers', body: 'Mobile: 9000000002' }, acking));
  assert.deepEqual([weak.customerMatch.status, weak.acknowledgement.status, weak.acknowledgement.reason], ['insufficient', 'skipped', 'customer_not_verified']);
  assert.equal((await ackOf(weak)).length, 0);
  assert.equal(ackOutbox.length, before + 2);
});

test('acknowledgement policy: an unmatched sender is not acknowledged unless the policy allows it', { skip }, async () => {
  const before = ackOutbox.length;
  const ticket = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Repair', body: 'Serial No: TESTSERIAL01' }, acking));
  assert.deepEqual([ticket.acknowledgement.status, ticket.acknowledgement.reason], ['skipped', 'customer_not_verified']);
  assert.equal((await ackOf(ticket)).length, 0);
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'acknowledgement_not_sent', 'details.reason': 'customer_not_verified' }));
  // Policy 'sender': the sender is acknowledged, without any registered customer's details.
  const lenient = createB2CService({ ...serviceOptions, models: b2cModels, config: ackConfig('sender'), ackSender: mockAckSender });
  const acknowledged = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Repair', body: 'Serial No: TESTSERIAL01' }, lenient));
  const [outbound] = await ackOf(acknowledged);
  assert.deepEqual([outbound.to, outbound.status], [UNREGISTERED, 'sent']);
  assert.doesNotMatch(outbound.bodyText, /TESTSERIAL01|Test Customer One/, 'an unverified serial number and other customers are not quoted');
  assert.equal(ackOutbox.length, before + 1);
});

test('acknowledgement: the registered address is never used, even when it is invalid', { skip }, async () => {
  // Bypasses schema validation to stand in for bad legacy data.
  await Customer.collection.insertOne({ customerId: 9001, name: 'Broken Record', email: 'not-an-address', mobileNumber: '9000000077', deviceSerialNumber: 'BROKEN0001' });
  const ticket = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Repair', body: 'Name: Broken Record\nMobile: 9000000077' }, acking));
  assert.equal(ticket.customerMatch.status, 'matched');
  const [outbound, ...extra] = await ackOf(ticket);
  assert.deepEqual([extra.length, outbound.to, outbound.status, ticket.acknowledgement.status], [0, UNREGISTERED, 'sent', 'sent']);
});

test('acknowledgement: a temporary SMTP failure is retried with backoff; a permanent one is parked as failed', { skip }, async () => {
  ackFailures.push(Object.assign(new Error('Could not reach the SMTP server (ETIMEDOUT).'), { retryable: true }));
  const ticket = await ticketOf(await deliver({ from: CUSTOMER_ONE, subject: 'Repair delayed', body: 'Serial No: TESTSERIAL01' }, acking));
  let [outbound] = await ackOf(ticket);
  assert.deepEqual([outbound.status, outbound.attempts, Boolean(outbound.nextAttemptAt)], ['retrying', 1, true]);
  assert.equal((await B2CEscalation.findById(ticket._id).lean()).acknowledgement.status, 'queued', 'not marked sent');
  assert.equal((await B2CEscalation.findById(ticket._id).lean()).status, 'Engineer Assigned', 'the ticket is unaffected');
  const messageId = outbound.messageId;
  advanceMinutes(2);
  await acking.runCycle('test');
  [outbound] = await ackOf(ticket);
  assert.deepEqual([outbound.status, outbound.attempts, outbound.messageId], ['sent', 2, messageId], 'the retry reuses the Message-ID');
  assert.equal((await ackOf(ticket)).length, 1);

  ackFailures.push(Object.assign(new Error('The SMTP server refused the message (550).'), { retryable: false }));
  const refused = await ticketOf(await deliver({ from: CUSTOMER_ONE, subject: 'Repair again', body: 'Serial No: TESTSERIAL01' }, acking));
  [outbound] = await ackOf(refused);
  assert.deepEqual([outbound.status, outbound.lastError], ['failed', 'The SMTP server refused the message (550).']);
  assert.equal((await B2CEscalation.findById(refused._id).lean()).acknowledgement.status, 'failed');
  // An admin retry sends it once the problem is fixed.
  assert.equal((await acking.retryOutbound(String(outbound._id))).status, 'sent');
  assert.equal((await B2CEscalation.findById(refused._id).lean()).acknowledgement.status, 'sent');
});

test('acknowledgement: nothing is queued when the ticket cannot be created', { skip }, async () => {
  const before = await B2COutboundEmail.countDocuments({ kind: 'acknowledgement' });
  const brokenCounter = { findOneAndUpdate: async () => { throw new Error('database hiccup'); } };
  const broken = createB2CService({ ...serviceOptions, models: { ...b2cModels, B2CCounter: brokenCounter }, config: ackConfig('verified'), ackSender: mockAckSender });
  const inbound = await deliver({ from: CUSTOMER_ONE, subject: 'Repair', body: 'Serial No: TESTSERIAL01' }, broken);
  assert.deepEqual([inbound.status, inbound.ticketId ?? null], ['retrying', null]);
  assert.equal(await B2COutboundEmail.countDocuments({ kind: 'acknowledgement' }), before);
  // Processed normally afterwards: exactly one ticket and one acknowledgement.
  advanceMinutes(2);
  await acking.runCycle('test');
  const ticket = await ticketOf(await B2CInboundEmail.findById(inbound._id).lean());
  assert.equal((await ackOf(ticket)).length, 1);
});

test('acknowledgement: with the company sender off, the inbox connector sends it as before', { skip }, async () => {
  const ticket = await ticketOf(await deliver({ from: CUSTOMER_ONE, subject: 'Repair', body: 'Serial No: TESTSERIAL01' }));
  const [outbound] = await ackOf(ticket);
  assert.deepEqual([outbound.via, outbound.provider, outbound.to], ['inbox', 'test', CUSTOMER_ONE]);
  assert.equal((await api(users.admin, 'GET', '/integrations/health')).body.ackSender, null);
});

// ---- Every ticket with an assigned engineer is acknowledged -------------------------------------
const asStaff = user => ({ id: String(user._id), name: user.name, email: user.email, role: user.role, b2cRole: user.b2cRole, b2cRegions: user.b2cRegions || [] });

test('acknowledgement: a ticket whose acknowledgement a receive-only inbox could not send is acknowledged when an engineer is assigned', { skip }, async () => {
  // As with the IMAP inbox before the company sender was turned on: the acknowledgement is skipped.
  const receiveOnly = createB2CService({ ...serviceOptions, models: b2cModels, config, emailConnectors: { ...serviceOptions.emailConnectors, canSend: () => false } });
  const inbound = await deliver({ from: CUSTOMER_TWO, name: 'Test Customer Two', subject: 'Repair', body: 'My phone is broken.' }, receiveOnly);
  let ticket = await ticketOf(inbound);
  assert.deepEqual([ticket.status, ticket.acknowledgement.status, ticket.acknowledgement.reason], ['Engineer Assigned', 'skipped', 'receive_only_inbox']);
  const before = ackOutbox.length;

  // With the company sender on, assigning the engineer sends it, once.
  await acking.performAction(String(ticket._id), 'assign', { userId: String(users.cm._id) }, asStaff(users.admin));
  await acking.runCycle('test');
  ticket = await ticketOf(inbound);
  const acks = await ackOf(ticket);
  assert.deepEqual(acks.map(item => [item.via, item.status]), [['inbox', 'skipped'], ['company_sender', 'sent']]);
  assert.deepEqual([ticket.acknowledgement.status, String(ticket.acknowledgement.outboundId)], ['sent', String(acks[1]._id)]);
  assert.equal(ackOutbox.length, before + 1);
  assert.deepEqual([ackOutbox.at(-1).to, ackOutbox.at(-1).subject], [CUSTOMER_TWO, `Support Request Received – Ticket [${ticket.reference}]`]);
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'acknowledgement_queued', 'details.onAssignment': true, 'details.previousReason': 'receive_only_inbox' }));

  // Assigning again, reprocessing the email and further cycles send nothing more.
  await acking.performAction(String(ticket._id), 'assign', { userId: String(users.cm._id) }, asStaff(users.admin));
  await acking.processInbound(await B2CInboundEmail.findById(inbound._id));
  await acking.runCycle('test');
  assert.equal((await ackOf(ticket)).length, 2);
  assert.equal(ackOutbox.length, before + 1);
});

test('acknowledgement: a customer identified in triage is acknowledged when the ticket is routed to an engineer', { skip }, async () => {
  const before = ackOutbox.length;
  // One detail only: the customer is not verified, so nothing is sent yet.
  const inbound = await deliver({ from: UNREGISTERED, subject: 'Repair', body: 'Mobile: 9000000002' }, acking);
  let ticket = await ticketOf(inbound);
  assert.deepEqual([ticket.status, ticket.acknowledgement.status, ticket.acknowledgement.reason], ['Pending Triage', 'skipped', 'customer_not_verified']);
  // The admin adds the serial number: with the phone number it identifies Customer Two, whose
  // device routes the ticket to the West Cluster Manager.
  const triaged = await acking.performAction(String(ticket._id), 'complete_triage', { category: 'Service', identifiers: [{ type: 'serialNumber', value: 'TESTSERIAL02' }] }, asStaff(users.admin));
  assert.deepEqual([triaged.ticket.customerMatch.status, triaged.ticket.status], ['matched', 'Engineer Assigned']);
  await acking.runCycle('test');
  ticket = await ticketOf(inbound);
  const [outbound, ...extra] = await ackOf(ticket);
  assert.equal(extra.length, 0);
  assert.deepEqual([outbound.to, outbound.status, ticket.acknowledgement.status], [UNREGISTERED, 'sent', 'sent']);
  assert.ok(ackOutbox.at(-1).text.includes(`Ticket Number: ${ticket.reference}`));
  assert.equal(ackOutbox.length, before + 1);

  // Still unverified after triage (policy 'verified'): the policy is kept, and nothing new is recorded.
  const unverified = await ticketOf(await deliver({ from: UNREGISTERED, subject: 'Repair', body: 'Nothing else.' }, acking));
  const notSent = () => B2CAuditEvent.countDocuments({ ticketId: unverified._id, action: 'acknowledgement_not_sent' });
  await acking.performAction(String(unverified._id), 'complete_triage', { category: 'Service', region: 'Test Region North', regionReason: 'Confirmed by phone', userId: String(users.cm._id) }, asStaff(users.admin));
  const after = await B2CEscalation.findById(unverified._id).lean();
  assert.deepEqual([after.status, after.acknowledgement.status, after.acknowledgement.reason], ['Engineer Assigned', 'skipped', 'customer_not_verified']);
  assert.equal(await notSent(), 1);
  assert.equal((await ackOf(unverified)).length, 0);
});

// ---- Incoming email from an IMAP mailbox (mocked server) --------------------------------------
test('IMAP: an email in the mailbox becomes a routed ticket, is marked read once stored, and no customer email is sent', { skip }, async () => {
  const { inboxes } = await service.getSettings();
  const added = await api(users.admin, 'PUT', '/settings', { inboxes: [...inboxes, { key: 'aavoraa', address: 'sender@mock.test', displayName: 'Aavoraa support', provider: 'imap', outboundProvider: 'smtp', enabled: true }] });
  assert.equal(added.status, 200);
  assert.equal('outboundProvider' in added.body.inboxes.at(-1), false, 'the retired SMTP setting is not stored');
  const adapterSent = sent().length;
  const ticketsBefore = await B2CEscalation.countDocuments();
  try {
    imapServer.messages.push({ uid: 41, seen: false, source: imapMime({ from: CUSTOMER_ONE, subject: 'Phone repair delayed', messageId: '<imap-flow-1@client.test>', body: 'Hello,\r\nCase ID: TEST-CASE-0001\r\nSerial No: TESTSERIAL01\r\nMy repair is late.' }) });
    await service.runCycle('test');
    const inbound = await B2CInboundEmail.findOne({ dedupeKey: 'aavoraa:9:41' }).lean();
    assert.deepEqual([inbound.status, inbound.outcome, inbound.provider], ['processed', 'ticket_created', 'imap']);
    assert.equal(imapServer.messages[0].seen, true, 'marked read only after it was stored');
    const ticket = await ticketOf(inbound);
    assert.deepEqual([ticket.inboxKey, ticket.customer.email, ticket.region], ['aavoraa', CUSTOMER_ONE, 'Test Region North']);
    // The inbox is receive-only: the acknowledgement is recorded on the ticket as not sent.
    assert.equal(ticket.acknowledgement.status, 'skipped');
    const ack = await B2COutboundEmail.findById(ticket.acknowledgement.outboundId).lean();
    assert.deepEqual([ack.status, ack.heldReason, ack.provider], ['skipped', 'receive_only_inbox', 'imap']);
    assert.equal(sent().length, adapterSent, 'nothing went through the test adapter');
    assert.ok(await B2CAuditEvent.findOne({ ticketId: ticket._id, action: 'email_not_sent' }).lean());

    // The next poll finds nothing new: no second ticket or acknowledgement.
    await service.runCycle('test');
    assert.equal(await B2CEscalation.countDocuments(), ticketsBefore + 1);
    assert.equal(await B2COutboundEmail.countDocuments({ ticketId: ticket._id, kind: 'acknowledgement' }), 1);

    // The customer's follow-up, quoting the reference, joins the same ticket.
    imapServer.messages.push({ uid: 42, seen: false, source: imapMime({ from: CUSTOMER_ONE, subject: `Re: [${ticket.reference}] Phone repair delayed`, messageId: '<imap-flow-2@client.test>', inReplyTo: '<imap-flow-1@client.test>', body: 'Any update?' }) });
    await service.runCycle('test');
    const reply = await B2CInboundEmail.findOne({ dedupeKey: 'aavoraa:9:42' }).lean();
    assert.deepEqual([reply.outcome, String(reply.ticketId)], ['appended_to_ticket', String(ticket._id)]);

    const health = await api(users.admin, 'GET', '/integrations/health');
    const card = health.body.inboxes.find(item => item.key === 'aavoraa');
    assert.deepEqual([card.provider, card.mode, card.outbound, card.status.details.stored], ['imap', 'live', null, 1]);
    assert.equal(health.body.smtp, undefined);
    assert.deepEqual(health.body.imap.inboxes, ['aavoraa']);
  } finally {
    await api(users.admin, 'PUT', '/settings', { inboxes });
  }
});

test('IMAP connection check: admin only, no secrets, recorded, rate limited; SMTP endpoints are gone', { skip }, async () => {
  assert.equal((await api(null, 'POST', '/integrations/imap/verify')).status, 401);
  assert.equal((await api(users.cm, 'POST', '/integrations/imap/verify')).status, 403);
  assert.equal((await api(users.admin, 'POST', '/integrations/smtp/verify')).status, 404);
  assert.equal((await api(users.admin, 'POST', '/integrations/smtp/test-email', { to: 'admin@staff.test' })).status, 404);

  const verified = await api(users.admin, 'POST', '/integrations/imap/verify');
  assert.equal(verified.status, 200);
  assert.equal(verified.body.ok, true);
  assert.match(verified.body.message, /No email was read or changed/);
  assert.deepEqual(verified.body.server, { host: 'mail.mock.test', port: 993, secure: true, mailbox: 'INBOX', user: 'sender@mock.test' });

  imapClient.usable = false;
  imapClient.connectError = Object.assign(new Error(`Authentication failed (${IMAP_SECRET})`), { authenticationFailed: true });
  const failed = await api(users.admin, 'POST', '/integrations/imap/verify');
  imapClient.connectError = null;
  assert.deepEqual([failed.status, failed.body.ok, failed.body.retryable], [200, false, false]);
  assert.match(failed.body.error, /IMAP login failed/);
  const health = await api(users.admin, 'GET', '/integrations/health');
  assert.equal(health.body.imap.status.consecutiveFailures, 1);
  for (const body of [verified.body, failed.body, health.body]) assert.doesNotMatch(JSON.stringify(body), new RegExp(`${IMAP_SECRET}|"pass"`));
  assert.equal(await B2CAuditEvent.countDocuments({ action: 'imap_connection_tested' }), 2);

  // Two attempts so far; three more are allowed and the sixth is refused until the window passes.
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await api(users.admin, 'POST', '/integrations/imap/verify')).status, 200);
  assert.equal((await api(users.admin, 'POST', '/integrations/imap/verify')).status, 429);
  advanceMinutes(16);
  assert.equal((await api(users.admin, 'POST', '/integrations/imap/verify')).status, 200);
});
