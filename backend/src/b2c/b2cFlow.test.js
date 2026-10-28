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
import { Notification, User } from '../models.js';
import { auth, restrictB2COnlyStaff } from '../middleware.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { runStaffCommand, StaffCommandError } from './b2cStaff.js';
import { b2cModels, ensureB2CIndexes } from './b2cModels.js';
import { createB2CService } from './b2cService.js';
import { createB2CRouter } from './b2cRoutes.js';
import { createTestEmailAdapter } from './connectors/testEmailAdapter.js';
import { createTestCrmAdapter } from './connectors/testCrmAdapter.js';
import { createEmailConnectors } from './connectors/emailConnector.js';
import { createAttachmentStore } from './attachments.js';
import { loadB2CConfig } from './b2cConfig.js';
import { DEFAULT_TEMPLATES } from './b2cDefaults.js';

const JWT_SECRET = 'b2c-flow-test-secret';
process.env.JWT_SECRET = JWT_SECRET;
const DB_NAME = `iplanet_b2c_test_${process.pid}_${Date.now()}`;
const INBOX = 'escalations@b2c-inbox.test';
const CUSTOMER_ONE = 'test.customer.one@example.test';
const CUSTOMER_TWO = 'test.customer.two@example.test';
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
const config = { ...loadB2CConfig({}), attachmentDir, crmProvider: 'test', pollMinutes: 0 };
const notifications = [];
// Mirrors server.js notifyUsers: one in-app Notification per recipient.
const notifyUsers = async notification => {
  notifications.push(notification);
  await Notification.insertMany(notification.users.map(user => ({ user: user._id, portalRole: user.role, type: notification.type, title: notification.title, message: notification.message, action: notification.action, read: false })));
};
const serviceOptions = { User, notifyUsers, emailConnectors: createEmailConnectors({ config, testAdapter: emailAdapter }), crmConnector: crmAdapter, attachmentStore: createAttachmentStore({ dir: attachmentDir }), logger: silent, now };
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
function sendEmail({ from = CUSTOMER_ONE, subject = '', body = '', headers = {}, attachments = [], internetMessageId, providerMessageId } = {}) {
  sequence += 1;
  return emailAdapter.inject(INBOX, { providerMessageId, internetMessageId: internetMessageId || `<message-${sequence}@client.test>`, from: { address: from, name: 'Test Customer' }, to: [INBOX], subject, text: body, headers, attachments, receivedAt: now().toISOString() });
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
  users.cm = await make('cluster', 'cluster_manager');
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
  const inbound = await deliver({ subject: 'Repair taking too long', body: 'Hello,\nCase ID: TEST-CASE-0001\nThe repair of my phone is delayed.' });
  assert.equal(inbound.status, 'processed');
  assert.equal(inbound.outcome, 'ticket_created');
  let ticket = await ticketOf(inbound);
  assert.match(ticket.reference, /^B2C-\d{4}-000001$/);
  assert.equal(ticket.category, 'Service');
  assert.deepEqual(ticket.identifiers.map(item => [item.type, item.value]), [['caseId', 'TEST-CASE-0001']]);
  assert.equal(ticket.crm.status, 'matched');
  assert.equal(ticket.customer.name, 'Test Customer One');
  assert.equal(ticket.region, 'Test Region North');
  assert.equal(ticket.devices[0].serialNumber, 'TESTSERIAL01');
  // The only Cluster Manager receives it directly.
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
  assert.ok(ack.subject.startsWith(`[${ticket.reference}]`));
  assert.match(ack.text, new RegExp(ticket.reference));
  const actions = (await B2CAuditEvent.find({ ticketId: ticket._id }).sort({ at: 1 }).lean()).map(event => event.action);
  for (const action of ['created_from_email', 'crm_lookup', 'routed', 'acknowledgement_queued', 'email_sent']) assert.ok(actions.includes(action), action);
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

test('emails without an approved identifier go to the admin-only triage queue and are routed after triage', { skip }, async () => {
  const inbound = await deliver({ from: CUSTOMER_TWO, subject: 'Store experience', body: 'The store staff did not help me.' });
  let ticket = await ticketOf(inbound);
  assert.equal(ticket.status, 'Pending Triage');
  assert.deepEqual(ticket.triage.reasons, ['missing_identifier']);
  assert.equal(ticket.category, 'Retail');
  assert.equal(ticket.acknowledgement.status, 'sent', 'the customer is still acknowledged');
  assert.equal((await api(users.cm, 'GET', `/tickets/${ticket._id}`)).status, 404);
  assert.equal((await act(users.cm, ticket, 'complete_triage', { category: 'Retail' })).status, 404);
  const queue = await api(users.admin, 'GET', '/tickets?status=Pending%20Triage');
  assert.ok(queue.body.items.some(item => item.reference === ticket.reference));
  const detail = await api(users.admin, 'GET', `/tickets/${ticket._id}`);
  assert.ok(detail.body.allowedActions.includes('complete_triage'));
  assert.equal((await act(users.admin, ticket, 'complete_triage', { category: 'Gadgets' })).status, 400);
  const triaged = await act(users.admin, ticket, 'complete_triage', { category: 'Retail', identifiers: [{ type: 'serialNumber', value: 'testserial02' }] });
  assert.equal(triaged.status, 200);
  ticket = triaged.body.ticket;
  assert.equal(ticket.status, 'Engineer Assigned');
  assert.equal(ticket.crm.status, 'matched');
  assert.ok(ticket.identifiers.some(item => item.value === 'TESTSERIAL02' && item.source === 'manual'));
  assert.ok(triaged.body.audit.some(event => event.action === 'triage_completed' && event.details.overriddenReasons.includes('missing_identifier')));
});

test('an email matching both categories is not guessed', { skip }, async () => {
  const ticket = await ticketOf(await deliver({ subject: 'Repair invoice', body: 'Case ID: TEST-CASE-0001 — the repair invoice is wrong.' }));
  assert.equal(ticket.category, 'Unclassified');
  assert.deepEqual(ticket.triage.reasons, ['ambiguous_category']);
});

test('a CRM outage is retried with backoff and the ticket routes itself once the lookup succeeds', { skip }, async () => {
  crmAdapter.failNext(Object.assign(new Error('CRM returned HTTP 503'), { retryable: true }));
  const inbound = await deliver({ from: CUSTOMER_TWO, subject: 'Repair status', body: 'Case ID: TEST-CASE-0002, repair pending.' });
  let ticket = await ticketOf(inbound);
  assert.equal(ticket.crm.status, 'error');
  assert.deepEqual(ticket.triage.reasons, ['crm_error']);
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
  const inbound = await deliver({ subject: 'Repair photos', body: 'Case ID: TEST-CASE-0001', attachments: [
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
  const inbound = await deliver({ subject: 'Repair SLA check', body: 'Case ID: TEST-CASE-0001\nStill waiting for the repair.' }, monitored);
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
  assert.ok(outbox.body.some(message => message.subject.startsWith(`[${injected.body.email.ticket.reference}]`)));

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
