// Customer registration: an email whose sender cannot be identified gets a single-use
// registration link and no ticket; the submitted details are checked against the device and
// customer records and saved, and only then is the ticket created from the original email,
// routed by the device's region and acknowledged. Unit tests for the pure rules, then end-to-end
// tests over HTTP with a real MongoDB (a new, uniquely named database, dropped afterwards;
// set B2C_TEST_MONGODB_URI for another server; skipped when MongoDB is not reachable). No
// real email is sent: the inbox is the test adapter and the company sender is a mock.
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
import { hashPassword } from '../passwords.js';
import { b2cModels, ensureB2CIndexes } from './b2cModels.js';
import { createB2CService } from './b2cService.js';
import { createB2CPublicRouter, createB2CRouter } from './b2cRoutes.js';
import { createTestEmailAdapter } from './connectors/testEmailAdapter.js';
import { createCrmConnector } from './connectors/crmConnector.js';
import { createCustomerDirectory, createDeviceDirectory } from './index.js';
import { createEmailConnectors } from './connectors/emailConnector.js';
import { createAttachmentStore } from './attachments.js';
import { loadB2CConfig, loadRegistrationConfig } from './b2cConfig.js';
import { DEFAULT_TEMPLATES } from './b2cDefaults.js';
import { hashRegistrationToken, isRegistrationToken, newRegistrationToken, resolveRegistration, validateRegistration } from './registration.js';
import { findPrematureTickets } from './prematureTickets.js';

// ---- Unit: tokens, form validation, verification rules ------------------------------------
test('registration tokens are random, 256-bit, URL-safe, and only their hash is stored', () => {
  const tokens = new Set(Array.from({ length: 200 }, newRegistrationToken));
  assert.equal(tokens.size, 200, 'never repeated');
  for (const token of tokens) assert.ok(isRegistrationToken(token), token);
  const [token] = tokens;
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.match(hashRegistrationToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashRegistrationToken(token), token);
  assert.equal(hashRegistrationToken(token), hashRegistrationToken(token));
  for (const bad of ['', 'short', `${token}x`, `${token.slice(0, 42)}!`, null, 42]) assert.equal(isRegistrationToken(bad), false, String(bad));
});

test('registration config: off by default, HTTPS required in production, bounded limits', () => {
  assert.equal(loadRegistrationConfig({}).enabled, false);
  assert.equal(loadRegistrationConfig({ NODE_ENV: 'production', B2C_REGISTRATION_PORTAL_URL: 'http://portal.example.test' }).portalUrl, '');
  assert.equal(loadRegistrationConfig({ NODE_ENV: 'production', B2C_REGISTRATION_PORTAL_URL: 'https://portal.example.test/' }).portalUrl, 'https://portal.example.test');
  assert.equal(loadRegistrationConfig({ B2C_REGISTRATION_PORTAL_URL: 'javascript:alert(1)' }).portalUrl, '');
  assert.equal(loadRegistrationConfig({ B2C_REGISTRATION_TTL_HOURS: '100000' }).ttlHours, 72);
});

const REGIONS = ['Test Region North', 'Test Region West'];
const VALID = { name: 'Test Person', email: 'Test.Person@Example.test', phone: '+91 98765 43210', serialNumber: ' regser0001 ', purchaseDate: '2026-03-01', purchaseLocation: 'Test Store, Test City', confirm: true };
test('the form is validated and normalised on the server; unknown fields are ignored', () => {
  const { values, errors } = validateRegistration({ ...VALID, purchaseRegion: 'test region north', ticketId: 'x', customerId: 7, alternatePhone: '' }, { regions: REGIONS, now: new Date('2026-06-01') });
  assert.equal(errors, undefined);
  assert.deepEqual(values, { name: 'Test Person', email: 'test.person@example.test', phone: '+919876543210', serialNumber: 'REGSER0001', purchaseDate: new Date('2026-03-01T00:00:00Z'), purchaseLocation: 'Test Store, Test City', purchaseRegion: 'Test Region North' });
  const bad = validateRegistration({ name: '1', email: 'nope', phone: '12345', alternatePhone: '+91 98765 43210', serialNumber: 'AB', purchaseDate: '2027-01-01', purchaseLocation: '', purchaseRegion: 'Somewhere Else', invoiceNumber: '<script>' }, { regions: REGIONS, now: new Date('2026-06-01') });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['confirm', 'email', 'invoiceNumber', 'name', 'phone', 'purchaseDate', 'purchaseLocation', 'purchaseRegion', 'serialNumber']);
  assert.equal(validateRegistration({ ...VALID, alternatePhone: '9876543210' }, { regions: REGIONS }).errors.alternatePhone, 'The alternate number must differ from the mobile number.');
  assert.ok(validateRegistration({ ...VALID, purchaseDate: '2026-02-30' }, { regions: REGIONS }).errors.purchaseDate, 'not a real date');
  assert.ok(validateRegistration({ ...VALID, confirm: 'true' }, { regions: REGIONS }).errors.confirm, 'confirmation must be a real true');
  // Serial number and purchase date are optional, and still checked when given.
  const optional = validateRegistration({ ...VALID, serialNumber: '  ', purchaseDate: '' }, { regions: REGIONS, now: new Date('2026-06-01') });
  assert.equal(optional.errors, undefined);
  assert.deepEqual([optional.values.serialNumber, optional.values.purchaseDate], [undefined, undefined]);
  const invalid = validateRegistration({ ...VALID, serialNumber: 'AB', purchaseDate: '01/03/2026' }, { regions: REGIONS, now: new Date('2026-06-01') }).errors;
  assert.deepEqual(Object.keys(invalid).sort(), ['purchaseDate', 'serialNumber']);
});

test('verification: the region is the device record\'s, ownership is never taken over, partial matches go to review', () => {
  const values = validateRegistration(VALID, { regions: REGIONS, now: new Date('2026-06-01') }).values;
  const device = { _id: 'd1', serialNumber: 'REGSER0001', model: 'Model A', location: 'Test Region North', purchaseDate: new Date('2026-03-03') };
  const decide = extra => resolveRegistration({ values, devices: [device], ...extra });
  assert.deepEqual([decide({}).status, decide({}).customerRecord, decide({}).region], ['verified', 'created', 'Test Region North']);
  assert.equal(resolveRegistration({ values, devices: [] }).reason, 'serial_not_found');
  assert.equal(resolveRegistration({ values, devices: [device, { ...device, _id: 'd2' }] }).reason, 'multiple_device_matches');
  // A device without a region verifies the customer; the ticket then goes to manual triage.
  const noRegion = resolveRegistration({ values, devices: [{ ...device, location: '' }] });
  assert.deepEqual([noRegion.status, noRegion.customerRecord, noRegion.region, noRegion.checks.includes('device_region_missing')], ['verified', 'created', null, true]);
  assert.equal(resolveRegistration({ values: { ...values, purchaseRegion: 'Test Region North' }, devices: [{ ...device, location: '' }] }).region, null, 'a stated region never stands in for the device record');
  assert.equal(resolveRegistration({ values: { ...values, purchaseRegion: 'Test Region West' }, devices: [device] }).reason, 'purchase_region_mismatch');
  assert.equal(resolveRegistration({ values, devices: [{ ...device, purchaseDate: new Date('2025-01-01') }] }).reason, 'purchase_date_mismatch');
  const owner = { _id: 'c1', customerId: 1, name: 'Someone Else', email: 'else@example.test', mobileNumber: '+919000000099', deviceSerialNumber: 'REGSER0001' };
  assert.equal(decide({ serialOwners: [owner] }).reason, 'serial_registered_to_other_customer');
  const self = { ...owner, name: 'Test Person', email: 'test.person@example.test' };
  assert.deepEqual([decide({ serialOwners: [self], candidates: [self] }).customerRecord, decide({ serialOwners: [self], candidates: [self] }).customer.customerId], ['existing', 1]);
  const known = { _id: 'c2', customerId: 2, name: 'Test Person', email: 'test.person@example.test', mobileNumber: '+919000000050', deviceSerialNumber: 'OTHER00001' };
  const linked = decide({ candidates: [known] });
  assert.deepEqual([linked.customerRecord, linked.customer.mobileNumber], ['linked', '+919000000050'], 'the stored details are kept, not the submitted ones');
  assert.equal(decide({ candidates: [{ ...known, name: 'Different Name', mobileNumber: '+919000000051' }] }).reason, 'customer_details_partial_match');
  // No purchase date: the device record's date is not compared; nothing else changes.
  const undated = resolveRegistration({ values: { ...values, purchaseDate: undefined }, devices: [{ ...device, purchaseDate: new Date('2025-01-01') }] });
  assert.deepEqual([undated.status, undated.customerRecord, undated.region, undated.checks.includes('purchase_date_confirmed')], ['verified', 'created', 'Test Region North', false]);
  // No serial number: no device and no region. A registered customer is verified with their
  // stored record (the ticket goes to manual triage); anyone else goes to review.
  const noSerial = { ...values, serialNumber: undefined };
  const matched = resolveRegistration({ values: noSerial, candidates: [known] });
  assert.deepEqual([matched.status, matched.customerRecord, matched.customer.customerId, matched.region, matched.device], ['verified', 'existing', 2, null, null]);
  assert.equal(resolveRegistration({ values: noSerial, candidates: [] }).reason, 'serial_number_missing');
  assert.equal(resolveRegistration({ values: noSerial, candidates: [{ ...known, name: 'Different Name', mobileNumber: '+919000000051' }] }).reason, 'customer_details_partial_match');
});

// ---- End to end -------------------------------------------------------------------------------
const JWT_SECRET = 'b2c-registration-test-secret';
process.env.JWT_SECRET = JWT_SECRET;
const DB_NAME = `iplanet_b2c_test_reg_${process.pid}_${Date.now()}`;
const INBOX = 'escalations@b2c-inbox.test';
const COMPANY_SENDER = 'noreply@company.test';
const PORTAL = 'https://portal.example.test';
const { B2CEscalation, B2CInboundEmail, B2COutboundEmail, B2CAuditEvent, B2CRegistrationRequest, B2CCounter } = b2cModels;
const silent = { info() {}, warn() {}, error() {} };

let mongoAvailable = true;
try { await mongoose.connect(process.env.B2C_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017', { dbName: DB_NAME, serverSelectionTimeoutMS: 3000 }); } catch { mongoAvailable = false; }
const skip = mongoAvailable ? false : 'MongoDB is not reachable (set B2C_TEST_MONGODB_URI)';

let clock = new Date('2026-06-01T09:00:00Z').getTime();
const now = () => new Date(clock);
const advanceMinutes = minutes => { clock += minutes * 60_000; };
const attachmentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2c-registration-'));
const emailAdapter = createTestEmailAdapter();
const smtpOutbox = [];
const smtpFailures = [];
// Stands in for connectors/smtpAckSender.js: records what would be sent; can fail on demand.
const mockSender = {
  provider: 'smtp', mode: 'live', enabled: true, fromEmail: COMPANY_SENDER,
  isConfigured: () => true, configCheck: () => ({ configured: true, missing: [] }), describeServer: () => ({ host: 'smtp.mock.test', port: 465, security: 'SSL/TLS', from: COMPANY_SENDER }),
  async send(message) {
    const failure = smtpFailures.shift();
    if (failure) throw failure;
    smtpOutbox.push({ ...message, from: COMPANY_SENDER });
    return { providerMessageId: `<smtp-${smtpOutbox.length}@smtp.mock.test>`, responseCode: 250 };
  },
};
const baseConfig = loadB2CConfig({});
const config = {
  ...baseConfig, attachmentDir, pollMinutes: 0, crmProvider: 'none',
  ack: { ...baseConfig.ack, enabled: true, fromEmail: COMPANY_SENDER, companyName: 'Test Company', unmatchedPolicy: 'verified' },
  registration: { ...loadRegistrationConfig({ B2C_REGISTRATION_ENABLED: 'true', B2C_REGISTRATION_PORTAL_URL: PORTAL }) },
};
const serviceOptions = {
  User, notifyUsers: async () => {}, deviceDirectory: createDeviceDirectory(Device), customerDirectory: createCustomerDirectory(Customer),
  emailConnectors: createEmailConnectors({ config, testAdapter: emailAdapter }), crmConnector: createCrmConnector({ config }), attachmentStore: createAttachmentStore({ dir: attachmentDir }),
  ackSender: mockSender, logger: silent, now,
};
const service = createB2CService({ ...serviceOptions, models: b2cModels, config });

const users = {};
let server;
let baseUrl;
let sequence = 0;
const token = user => jwt.sign({ id: user._id, role: user.role, name: user.name }, JWT_SECRET);
async function call(method, url, { user, body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
}
const staffApi = (user, method, url, body) => call(method, `/api/b2c${url}`, { user, body });
const publicApi = (method, linkToken, suffix = '', body) => call(method, `/api/b2c/public/registration/${linkToken}${suffix}`, { body });

function sendEmail({ from, name = 'Test Sender', subject = 'Repair request', body = 'My phone needs repair.', inReplyTo }) {
  sequence += 1;
  const internetMessageId = `<reg-${sequence}@client.test>`;
  const providerMessageId = emailAdapter.inject(INBOX, { internetMessageId, inReplyTo, references: inReplyTo, from: { address: from, name }, to: [INBOX], subject, text: body, headers: {}, attachments: [], receivedAt: now().toISOString() });
  return { providerMessageId, internetMessageId };
}
// One email through a processing cycle: the stored email, its registration request and its ticket (if any).
async function deliver(options, runner = service) {
  const { providerMessageId } = sendEmail(options);
  await runner.runCycle('test');
  const inbound = await B2CInboundEmail.findOne({ dedupeKey: `test-inbox:${providerMessageId}` }).lean();
  return { inbound, request: await requestFor(inbound), ticket: await ticketFor(inbound) };
}
const ticketFor = inbound => B2CEscalation.findOne({ sourceEmailId: inbound._id }).lean();
const requestFor = inbound => B2CRegistrationRequest.findOne({ sourceEmailId: inbound._id }).lean();
const referenceCounter = async () => (await B2CCounter.findOne({ key: `reference-${now().getFullYear()}` }).lean())?.seq || 0;
const registrationMails = to => smtpOutbox.filter(message => message.to === to && /Customer Registration Required/.test(message.subject));
const ackMails = to => smtpOutbox.filter(message => message.to === to && /Support Request Received/.test(message.subject));
const linkToken = message => message.text.match(/\/b2c\/customer-registration\/([A-Za-z0-9_-]{43})/)?.[1];
const latestToken = to => linkToken(registrationMails(to).at(-1));
const reload = ticket => B2CEscalation.findById(ticket._id).lean();
const form = (overrides = {}) => ({ name: 'New Customer', email: 'new.customer@example.test', phone: '+91 91000 00010', serialNumber: 'REGSER0001', purchaseDate: '2026-03-01', purchaseLocation: 'Test Store, North City', brand: 'Test Brand', model: 'Model A', confirm: true, ...overrides });
const TICKET_NUMBER = /B2C-\d{4}-\d{6}/;

before(async () => {
  if (!mongoAvailable) return;
  await ensureB2CIndexes();
  await Promise.all([User.createIndexes(), Device.createIndexes(), Customer.createIndexes()]);
  const make = (name, b2cRole, extra = {}) => User.create({ name, email: `${name}@staff.test`, password: hashPassword('Test@123'), role: 'b2c_staff', b2cRole, ...extra });
  users.admin = await make('admin', 'b2c_admin', { role: 'iplanet_service' });
  // Cluster Managers cover North and West; nobody holds East.
  users.cmNorth = await make('cm-north', 'cluster_manager', { b2cRegions: ['Test Region North'] });
  users.cmWest = await make('cm-west', 'cluster_manager', { b2cRegions: ['Test Region West'] });
  users.corporate = await User.create({ name: 'corp', email: 'corp@staff.test', password: hashPassword('Test@123'), role: 'corporate_admin' });
  await Device.insertMany([
    { serialNumber: 'REGSER0001', model: 'Model A', location: 'Test Region North', purchaseDate: new Date('2026-03-01') },
    { serialNumber: 'REGSER0002', model: 'Model B', location: 'Test Region West' },
    { serialNumber: 'REGSER0003', model: 'Model A', location: 'Test Region North' },
    { serialNumber: 'REGSER0004', model: 'Model A', location: 'Test Region North' },
    { serialNumber: 'REGSER0005', model: 'Model B', location: 'Test Region West' },
    { serialNumber: 'REGSER0006', model: 'Model B', location: 'Test Region North' },
    { serialNumber: 'REGSER0007', model: 'Model B', location: 'Test Region West' },
    { serialNumber: 'REGSER0008', model: 'Model A', location: 'Test Region West' },
    { serialNumber: 'REGSER0009', model: 'Model A', location: 'Test Region North' },
    { serialNumber: 'REGSER0010', model: 'Model A', location: 'Test Region West' },
    { serialNumber: 'REGSER0011', model: 'Model A', location: 'Test Region North' },
    { serialNumber: 'REGSER0012', model: 'Model A', location: 'Test Region West' },
    { serialNumber: 'REGEAST001', model: 'Model C', location: 'Test Region East' },
    { serialNumber: 'REGNOLOC01', model: 'Model C' },
    { serialNumber: 'REGSER0013', model: 'Model A', location: 'Test Region North', purchaseDate: new Date('2026-03-01') },
  ]);
  for (const record of [
    { name: 'Known Customer', email: 'known@example.test', mobileNumber: '+919100000004', deviceSerialNumber: 'REGSER0004' },
    { name: 'Existing Owner', email: 'owner@example.test', mobileNumber: '+919100000003', deviceSerialNumber: 'REGSER0003' },
    { name: 'Partial Person', email: 'partial@example.test', mobileNumber: '+919100000002', deviceSerialNumber: 'OTHERDEV01' },
  ]) await Customer.create(record);
  const app = express();
  app.use(express.json());
  app.use('/api', restrictB2COnlyStaff);
  // Every test request comes from one address; the limits themselves are tested below.
  app.use('/api/b2c/public', createB2CPublicRouter({ service, logger: silent, limits: { view: 1000, submit: 1000, renew: 1000 } }));
  app.use('/api/b2c', createB2CRouter({ service, auth, User, Notification, logger: silent }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const saved = await staffApi(users.admin, 'PUT', '/settings', { classificationRules: [{ category: 'Service', keywords: ['repair'], enabled: true }, { category: 'Retail', keywords: ['invoice'], enabled: true }], templates: DEFAULT_TEMPLATES.map(template => ({ ...template, approved: true })) });
  assert.equal(saved.status, 200);
  assert.ok(saved.body.templates.some(template => template.key === 'registration_request' && template.approved));
});

after(async () => {
  server?.close();
  if (mongoAvailable) {
    assert.match(mongoose.connection.name, /^iplanet_b2c_test_reg_/);
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
  fs.rmSync(attachmentDir, { recursive: true, force: true });
});

test('an identified customer gets a ticket straight away: routed and acknowledged, no registration request', { skip }, async () => {
  const { inbound, ticket, request } = await deliver({ from: 'known@example.test', name: 'Known Customer', body: 'Please repair my phone. Serial No: REGSER0004' });
  assert.deepEqual([inbound.outcome, ticket.customerMatch.status, ticket.region, ticket.status], ['ticket_created', 'matched', 'Test Region North', 'Engineer Assigned']);
  assert.equal(String(ticket.workflow.assignee.userId), String(users.cmNorth._id));
  assert.equal(ticket.registration?.status, undefined);
  assert.equal(request, null);
  assert.equal(registrationMails('known@example.test').length, 0);
  assert.equal(ackMails('known@example.test').length, 1, 'the existing acknowledgement is unchanged');
});

test('an unidentified sender gets a registration request and email, and no ticket or ticket number', { skip }, async () => {
  const sender = 'stranger.one@example.test';
  const counter = await referenceCounter();
  const tickets = await B2CEscalation.countDocuments();
  const { inbound, request, ticket } = await deliver({ from: sender, subject: 'Phone repair', body: 'My phone needs repair.' });
  assert.equal(ticket, null, 'no ticket before registration');
  assert.equal(await B2CEscalation.countDocuments(), tickets);
  assert.equal(await referenceCounter(), counter, 'no ticket number generated or reserved');
  assert.deepEqual([inbound.status, inbound.outcome, inbound.ticketId ?? null], ['processed', 'awaiting_registration', null]);
  // The request keeps the original email, the issue and where the link went.
  assert.deepEqual([request.status, request.ticketId, request.recipient, request.sendCount, request.trigger], ['email_sent', null, sender, 1, 'not_found']);
  assert.deepEqual([String(request.sourceEmailId), request.internetMessageId, request.subject, request.issueSummary, request.inboxKey], [String(inbound._id), inbound.internetMessageId, 'Phone repair', 'Phone repair', 'test-inbox']);
  assert.ok(request.expiresAt > now());
  const [mail, ...more] = registrationMails(sender);
  assert.equal(more.length, 0);
  assert.deepEqual([mail.from, mail.to, mail.replyTo], [COMPANY_SENDER, sender, INBOX], 'from the approved sender to the address the email came from');
  assert.equal(mail.subject, 'Customer Registration Required – Complete Your Details', 'no ticket number in the subject');
  assert.ok(!TICKET_NUMBER.test(mail.text), 'nor in the body');
  for (const line of ['Dear Customer,', 'could not confidently match your customer and device details', 'Complete your registration: https://portal.example.test/b2c/customer-registration/', 'continue processing your support request', 'Test Company Support Team']) assert.ok(mail.text.includes(line), line);
  assert.equal(ackMails(sender).length, 0, 'no acknowledgement before a ticket exists');
  const linkValue = linkToken(mail);
  assert.ok(isRegistrationToken(linkValue));
  assert.equal(request.tokenHash, hashRegistrationToken(linkValue), 'only the hash is stored');
  // The registration email has its own status, on the request; it is tied to no ticket.
  const outbound = await B2COutboundEmail.findOne({ kind: 'registration', registrationId: request._id }).lean();
  assert.deepEqual([outbound.status, outbound.ticketId ?? null], ['sent', null]);
  assert.match(outbound.bodyText, /secure registration link — sent to the customer, not stored/);
  const events = await B2CAuditEvent.find({ registrationId: request._id }).lean();
  assert.deepEqual(events.map(event => event.action).sort(), ['email_sent', 'registration_requested']);
  assert.ok(events.every(event => event.ticketId === null));
  assert.ok(!JSON.stringify([request, outbound, events]).includes(linkValue), 'the token is in no record');
  // Polling again and reprocessing the same email add no request, email or ticket.
  await service.processInbound(await B2CInboundEmail.findById(inbound._id));
  await service.runCycle('test');
  assert.equal(await B2CRegistrationRequest.countDocuments({ sourceEmailId: inbound._id }), 1);
  assert.equal(registrationMails(sender).length, 1);
  assert.equal(await B2CEscalation.countDocuments({ sourceEmailId: inbound._id }), 0);
  assert.equal(await referenceCounter(), counter);
});

test('the link opens only its own form; invalid tokens reveal nothing and create nothing', { skip }, async () => {
  const sender = 'stranger.two@example.test';
  const { inbound, request } = await deliver({ from: sender, body: 'Repair please' });
  const opened = await publicApi('GET', latestToken(sender));
  assert.equal(opened.status, 200);
  assert.deepEqual([opened.body.state, opened.body.reference], ['valid', null]);
  assert.deepEqual(opened.body.regions, ['Test Region East', 'Test Region North', 'Test Region West']);
  assert.ok(opened.body.fields.some(field => field.key === 'email' && field.required));
  assert.ok(opened.body.fields.some(field => field.key === 'serialNumber' && !field.required), 'optional');
  assert.ok(opened.body.fields.some(field => field.key === 'purchaseDate' && !field.required), 'optional');
  assert.ok(!JSON.stringify(opened.body).includes(sender), 'no customer details');
  assert.equal(opened.headers.get('cache-control'), 'no-store');
  assert.equal(opened.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await requestFor(inbound)).status, 'in_progress');
  assert.ok(await B2CAuditEvent.exists({ registrationId: request._id, action: 'registration_opened' }));
  const customers = await Customer.countDocuments();
  for (const bad of [newRegistrationToken(), 'not-a-token']) {
    const response = await publicApi('GET', bad);
    assert.deepEqual([response.status, response.body.code], [404, 'invalid']);
    assert.equal((await publicApi('POST', bad, '', form({ email: sender, serialNumber: 'REGSER0008' }))).status, 404);
  }
  assert.equal(await Customer.countDocuments(), customers);
  assert.equal(await ticketFor(inbound), null);
  // Signing in is not granted by the link: staff endpoints still need a staff login.
  assert.equal((await staffApi(null, 'GET', '/registrations')).status, 401);
});

test('invalid form data is rejected with field errors; nothing is saved and the link stays usable', { skip }, async () => {
  const sender = 'stranger.three@example.test';
  const { inbound } = await deliver({ from: sender });
  const linkValue = latestToken(sender);
  const customers = await Customer.countDocuments();
  const rejected = await publicApi('POST', linkValue, '', { ...form({ email: 'bad', phone: '12', purchaseDate: '2030-01-01', purchaseRegion: 'Nowhere' }), confirm: false });
  assert.equal(rejected.status, 422);
  assert.deepEqual(Object.keys(rejected.body.fields).sort(), ['confirm', 'email', 'phone', 'purchaseDate', 'purchaseRegion']);
  const request = await requestFor(inbound);
  assert.deepEqual([request.status, request.failedAttempts, request.submittedAt ?? null], ['email_sent', 1, null]);
  assert.equal(await Customer.countDocuments(), customers);
  assert.equal(await ticketFor(inbound), null);
  assert.equal((await publicApi('GET', linkValue)).status, 200, 'still usable');
});

test('a verified registration is saved first, then exactly one ticket is created from the original email, routed by the device region and acknowledged once', { skip }, async () => {
  const sender = 'new.customer@example.test';
  const { inbound, request: pending } = await deliver({ from: sender, subject: 'Screen repair', body: 'The screen needs repair.' });
  const tickets = await B2CEscalation.countDocuments();
  const customers = await Customer.countDocuments();
  const linkValue = latestToken(sender);
  await publicApi('GET', linkValue);
  // Values a customer cannot choose: the ticket, the customer record, the request, the region.
  const submitted = await publicApi('POST', linkValue, '', { ...form(), ticketId: String(new mongoose.Types.ObjectId()), customerId: 1, requestId: String(new mongoose.Types.ObjectId()), region: 'Test Region West', purchaseRegion: 'Test Region North' });
  assert.deepEqual([submitted.status, submitted.body], [200, { state: 'submitted', reference: null }], 'the same answer whatever the outcome');
  const created = await Customer.findOne({ deviceSerialNumber: 'REGSER0001' }).lean();
  assert.deepEqual([created.name, created.email, created.mobileNumber], ['New Customer', 'new.customer@example.test', '+919100000010']);
  assert.equal(await Customer.countDocuments(), customers + 1);
  assert.equal(await B2CEscalation.countDocuments(), tickets + 1, 'exactly one ticket');
  const ticket = await ticketFor(inbound);
  const request = await requestFor(inbound);
  // Registration first: the customer record and the completed request precede the ticket.
  assert.ok(created.createdAt <= ticket.createdAt);
  assert.ok(request.completedAt <= (await B2CAuditEvent.findOne({ ticketId: ticket._id, action: 'created_from_email' }).lean()).at);
  assert.deepEqual([request.status, String(request.ticketId), request.reference, request.ticketCreatedBy, String(request._id)], ['completed', String(ticket._id), ticket.reference, 'registration', String(pending._id)]);
  assert.deepEqual([request.outcome.customerRecord, request.outcome.region], ['created', 'Test Region North']);
  assert.ok(request.outcome.checks.includes('purchase_date_confirmed') && request.outcome.checks.includes('purchase_region_confirmed'));
  // The ticket: the original email and issue, the registered customer and device, the device's region.
  assert.deepEqual([String(ticket.sourceEmailId), ticket.subject, ticket.customer.email], [String(inbound._id), 'Screen repair', sender]);
  assert.deepEqual([ticket.status, ticket.region, String(ticket.workflow.assignee.userId)], ['Engineer Assigned', 'Test Region North', String(users.cmNorth._id)]);
  assert.deepEqual([ticket.customerMatch.status, ticket.customerMatch.method, ticket.customerMatch.customerIds], ['matched', 'registration', [created.customerId]]);
  assert.deepEqual([ticket.regionAssignment.status, ticket.regionAssignment.source, ticket.regionAssignment.ownerCheck, ticket.regionAssignment.serialNumber], ['automatic', 'device_location', 'verified', 'REGSER0001']);
  assert.deepEqual([ticket.registration.status, String(ticket.registration.requestId), ticket.triage.reasons], ['completed', String(request._id), []]);
  const reloaded = await B2CInboundEmail.findById(inbound._id).lean();
  assert.deepEqual([String(reloaded.ticketId), reloaded.outcome], [String(ticket._id), 'ticket_created_after_registration']);
  // The ticket's history starts with the registration, and records how it was routed.
  const history = await B2CAuditEvent.find({ ticketId: ticket._id }).sort({ at: 1, _id: 1 }).lean();
  const actions = history.map(event => event.action);
  for (const action of ['registration_requested', 'registration_opened', 'created_from_email', 'registration_completed', 'region_identified', 'routed', 'acknowledgement_queued']) assert.ok(actions.includes(action), action);
  assert.ok(actions.indexOf('registration_requested') < actions.indexOf('created_from_email'));
  assert.equal(await B2CAuditEvent.countDocuments({ registrationId: request._id, ticketId: null }), 0);
  const routed = history.find(event => event.action === 'routed');
  assert.deepEqual([routed.details.region, routed.details.regionSource, routed.details.assignment], ['Test Region North', 'device_location', 'automatic']);
  assert.ok(!JSON.stringify(history.filter(event => event.action.startsWith('registration'))).includes('9100000010'), 'audit details hold no submitted values');
  assert.equal(String((await B2COutboundEmail.findOne({ kind: 'registration', registrationId: request._id }).lean()).ticketId), String(ticket._id), 'the registration email joins the ticket');
  // The acknowledgement goes out now, once, with the real ticket number and the issue.
  await service.runCycle('test');
  const [ack, ...extra] = ackMails(sender);
  assert.equal(extra.length, 0);
  assert.ok(ack.text.includes(`Ticket Number: ${ticket.reference}`));
  assert.ok(ack.text.includes('Device Serial Number: REGSER0001'));
  assert.ok(ack.text.includes('Issue Summary: Screen repair'));
  // The link cannot be used again, and repeating the work changes nothing.
  assert.deepEqual([(await publicApi('POST', linkValue, '', form())).status, (await publicApi('GET', linkValue)).body.code], [410, 'used']);
  await service.processInbound(await B2CInboundEmail.findById(inbound._id));
  await service.runCycle('test');
  assert.equal(ackMails(sender).length, 1);
  assert.equal(registrationMails(sender).length, 1);
  assert.equal(await Customer.countDocuments(), customers + 1);
  assert.equal(await B2CEscalation.countDocuments({ sourceEmailId: inbound._id }), 1);
});

test('an existing customer writing from another address is reused, not duplicated', { skip }, async () => {
  const sender = 'owner.other.address@example.test';
  const { inbound } = await deliver({ from: sender, body: 'Repair needed' });
  const customers = await Customer.countDocuments();
  const submitted = await publicApi('POST', latestToken(sender), '', form({ name: 'Existing Owner', email: 'owner@example.test', phone: '9100000003', serialNumber: 'REGSER0003' }));
  assert.equal(submitted.status, 200);
  assert.equal(await Customer.countDocuments(), customers);
  const ticket = await ticketFor(inbound);
  const owner = await Customer.findOne({ deviceSerialNumber: 'REGSER0003' }).lean();
  assert.deepEqual([ticket.customerMatch.customerIds, ticket.region, ticket.status], [[owner.customerId], 'Test Region North', 'Engineer Assigned']);
  assert.equal((await requestFor(inbound)).outcome.customerRecord, 'existing');
});

test('a submission that cannot be verified creates no ticket and waits for an admin, who can create the ticket for triage', { skip }, async () => {
  const customers = await Customer.countDocuments();
  const cases = [
    ['claimant@example.test', form({ name: 'Claimant Person', email: 'claimant@example.test', phone: '9100000020', serialNumber: 'REGSER0003' }), 'serial_registered_to_other_customer'],
    ['partial.other@example.test', form({ name: 'Another Name', email: 'partial@example.test', phone: '9100000021', serialNumber: 'REGSER0002' }), 'customer_details_partial_match'],
    ['typo@example.test', form({ name: 'Typo Person', email: 'typo@example.test', phone: '9100000022', serialNumber: 'NOSUCH0001' }), 'serial_not_found'],
    ['wrong.region@example.test', form({ name: 'Region Person', email: 'wrong.region@example.test', phone: '9100000023', serialNumber: 'REGSER0005', purchaseRegion: 'Test Region North' }), 'purchase_region_mismatch'],
  ];
  const held = [];
  for (const [sender, details, reason] of cases) {
    const { inbound } = await deliver({ from: sender, body: 'Repair needed' });
    const submitted = await publicApi('POST', latestToken(sender), '', details);
    // The same answer as a verified submission: the form cannot be used to probe the records.
    assert.deepEqual([submitted.status, submitted.body], [200, { state: 'submitted', reference: null }], reason);
    assert.equal(await ticketFor(inbound), null, `${reason}: no ticket`);
    const request = await requestFor(inbound);
    assert.deepEqual([request.status, request.reason, request.ticketId], ['manual_review', reason, null], reason);
    assert.ok(await B2CAuditEvent.exists({ registrationId: request._id, action: 'registration_needs_review' }), reason);
    // A B2C admin sees the reason and the submitted details; nobody sees the token.
    const detail = await staffApi(users.admin, 'GET', `/registrations/${request._id}`);
    assert.deepEqual([detail.status, detail.body.status, detail.body.reason, detail.body.submission.serialNumber, detail.body.actions], [200, 'manual_review', reason, details.serialNumber.toUpperCase(), ['resend', 'create_ticket']]);
    assert.equal(detail.body.recipient, `${sender[0]}***@example.test`);
    assert.ok(!JSON.stringify(detail.body).includes('tokenHash'));
    held.push({ request, inbound });
  }
  assert.equal(await Customer.countDocuments(), customers, 'no customer record created or changed');
  assert.deepEqual((await Customer.find({ deviceSerialNumber: 'REGSER0003' }).lean()).map(record => record.name), ['Existing Owner'], 'ownership unchanged');
  const listed = await staffApi(users.admin, 'GET', '/registrations?status=manual_review');
  assert.ok(held.every(({ request }) => listed.body.items.some(item => item.id === String(request._id))));
  assert.ok(!JSON.stringify(listed.body).includes('submission'), 'the list shows no submitted details');
  assert.equal((await staffApi(users.cmNorth, 'GET', '/registrations')).status, 403, 'admin only');
  assert.equal((await staffApi(users.cmNorth, 'POST', `/registrations/${held[0].request._id}/actions/create_ticket`, { reason: 'x' })).status, 403);
  // The admin decides to proceed: a reason is required; the ticket goes to triage, once.
  const { request, inbound } = held[2];
  assert.equal((await staffApi(users.admin, 'POST', `/registrations/${request._id}/actions/create_ticket`, {})).status, 400);
  const createdTicket = await staffApi(users.admin, 'POST', `/registrations/${request._id}/actions/create_ticket`, { reason: 'Customer confirmed the serial number by phone' });
  assert.equal(createdTicket.status, 200);
  const ticket = await ticketFor(inbound);
  assert.deepEqual([createdTicket.body.reference, ticket.status, ticket.registration.status, ticket.triage.reasons.includes('customer_registration_review')], [ticket.reference, 'Pending Triage', 'manual_review', true]);
  assert.equal((await requestFor(inbound)).ticketCreatedBy, 'staff');
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'ticket_created_without_registration', 'actor.name': 'admin' }));
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'registration_needs_review' }), 'the request history moved to the ticket');
  assert.equal((await staffApi(users.admin, 'GET', `/tickets/${ticket._id}`)).body.registration.submission.serialNumber, 'NOSUCH0001');
  assert.equal((await staffApi(users.admin, 'POST', `/registrations/${request._id}/actions/create_ticket`, { reason: 'again' })).status, 409);
  assert.equal(await B2CEscalation.countDocuments({ sourceEmailId: inbound._id }), 1);
  // Or the admin sends the link again, and a corrected registration creates the ticket.
  const retry = held[3];
  advanceMinutes(config.registration.resendMinutes);
  assert.equal((await staffApi(users.admin, 'POST', `/registrations/${retry.request._id}/actions/resend`)).status, 200);
  assert.equal(await ticketFor(retry.inbound), null);
  assert.equal((await publicApi('POST', latestToken('wrong.region@example.test'), '', form({ name: 'Region Person', email: 'wrong.region@example.test', phone: '9100000023', serialNumber: 'REGSER0005' }))).status, 200);
  const corrected = await ticketFor(retry.inbound);
  assert.deepEqual([corrected.status, corrected.region, corrected.registration.status], ['Engineer Assigned', 'Test Region West', 'completed']);
});

test('a verified registration whose device has no region, or whose region has no Cluster Manager, creates the ticket in manual triage', { skip }, async () => {
  const cases = [
    ['no.region@example.test', form({ name: 'Noloc Person', email: 'no.region@example.test', phone: '9100000024', serialNumber: 'REGNOLOC01' }), '', 'device_region_missing'],
    ['east.customer@example.test', form({ name: 'East Customer', email: 'east.customer@example.test', phone: '9100000030', serialNumber: 'REGEAST001' }), 'Test Region East', 'no_regional_assignee'],
  ];
  for (const [sender, details, region, reason] of cases) {
    const customers = await Customer.countDocuments();
    const { inbound } = await deliver({ from: sender, body: 'Repair needed' });
    assert.equal((await publicApi('POST', latestToken(sender), '', details)).status, 200);
    assert.equal(await Customer.countDocuments(), customers + 1, `${reason}: the registration is saved`);
    const ticket = await ticketFor(inbound);
    assert.deepEqual([ticket.status, ticket.region, ticket.triage.reasons, ticket.registration.status, ticket.customerMatch.method], ['Pending Triage', region, [reason], 'completed', 'registration'], reason);
    assert.equal(ticket.workflow.assignee?.userId ?? null, null, 'never assigned arbitrarily');
    if (!region) assert.deepEqual([ticket.regionAssignment.status, ticket.regionAssignment.reason], ['unresolved', 'device_region_missing'], 'no region guessed');
    await service.runCycle('test');
    assert.equal(ackMails(sender).length, 1, 'the ticket exists and the customer is verified');
  }
});

test('serial number and purchase date are optional: a registration without them is saved, and only a verified one creates a ticket', { skip }, async () => {
  // Both given: routed by the device region as usual.
  const both = 'both.fields@example.test';
  const withBoth = await deliver({ from: both, body: 'Repair needed' });
  assert.equal((await publicApi('POST', latestToken(both), '', form({ name: 'Both Fields', email: both, phone: '9100000077', serialNumber: 'REGSER0013', purchaseDate: '2026-03-02' }))).status, 200);
  const routed = await ticketFor(withBoth.inbound);
  assert.deepEqual([routed.status, routed.region, routed.regionAssignment.serialNumber], ['Engineer Assigned', 'Test Region North', 'REGSER0013']);
  assert.ok((await requestFor(withBoth.inbound)).outcome.checks.includes('purchase_date_confirmed'));

  // A registered customer writing from another address, both fields empty: verified with their
  // stored record (none created), the ticket is created and goes to manual triage, no serial invented.
  const known = await Customer.findOne({ email: 'known@example.test' }).lean();
  const sender = 'known.other.address@example.test';
  const customers = await Customer.countDocuments();
  const { inbound } = await deliver({ from: sender, body: 'Repair needed' });
  const submitted = await publicApi('POST', latestToken(sender), '', form({ name: 'Known Customer', email: 'known@example.test', phone: '9100000004', serialNumber: '', purchaseDate: '' }));
  assert.deepEqual([submitted.status, submitted.body], [200, { state: 'submitted', reference: null }]);
  assert.equal(await Customer.countDocuments(), customers, 'the stored record is used, not duplicated');
  const request = await requestFor(inbound);
  assert.deepEqual([request.status, request.outcome.customerRecord, request.outcome.region, request.submission.serialNumber ?? null], ['completed', 'existing', null, null]);
  const ticket = await ticketFor(inbound);
  assert.deepEqual([ticket.status, ticket.region, ticket.registration.status, ticket.customerMatch.customerIds], ['Pending Triage', '', 'completed', [known.customerId]]);
  assert.deepEqual([ticket.regionAssignment.status, ticket.regionAssignment.reason, ticket.regionAssignment.serialNumber ?? null], ['unresolved', 'serial_number_missing', null]);
  assert.ok(!ticket.identifiers.some(item => item.type === 'serialNumber'), 'no serial number invented');
  assert.ok(ticket.triage.reasons.length > 0, 'manual triage');
  assert.equal(ticket.workflow.assignee?.userId ?? null, null);
  assert.ok(request.completedAt <= ticket.createdAt, 'saved before the ticket');
  await service.runCycle('test');
  assert.equal(ackMails(sender).length, 1);

  // A new customer without a serial number: no purchase record can be made, so the submission is
  // kept for an admin and no ticket is created yet.
  const stranger = 'no.serial.new@example.test';
  const held = await deliver({ from: stranger, body: 'Repair needed' });
  const before = await Customer.countDocuments();
  assert.equal((await publicApi('POST', latestToken(stranger), '', form({ name: 'No Serial Person', email: stranger, phone: '9100000078', serialNumber: '', purchaseDate: '' }))).status, 200);
  const waiting = await requestFor(held.inbound);
  assert.deepEqual([waiting.status, waiting.reason, waiting.submission.email, waiting.ticketId], ['manual_review', 'serial_number_missing', stranger, null]);
  assert.equal(await ticketFor(held.inbound), null);
  assert.equal(await Customer.countDocuments(), before);

  // A serial number or date that is given is still checked.
  const checked = 'checked.fields@example.test';
  await deliver({ from: checked, body: 'Repair needed' });
  const rejected = await publicApi('POST', latestToken(checked), '', form({ email: checked, serialNumber: 'AB', purchaseDate: '2026-02-30' }));
  assert.deepEqual([rejected.status, Object.keys(rejected.body.fields).sort()], [422, ['purchaseDate', 'serialNumber']]);
});

test('an expired link is refused and creates no ticket; the customer can ask for a new one', { skip }, async () => {
  const sender = 'late.customer@example.test';
  const { inbound, request } = await deliver({ from: sender, body: 'Repair needed' });
  const first = latestToken(sender);
  advanceMinutes(config.registration.ttlHours * 60 + 1);
  const expired = await publicApi('GET', first);
  assert.deepEqual([expired.status, expired.body.code, expired.body.canRenew], [410, 'expired', true]);
  assert.equal((await publicApi('POST', first, '', form({ email: sender, serialNumber: 'REGSER0006' }))).status, 410);
  assert.equal((await requestFor(inbound)).status, 'expired');
  assert.ok(await B2CAuditEvent.exists({ registrationId: request._id, action: 'registration_expired' }));
  assert.equal(await ticketFor(inbound), null);
  // An unknown token gets the same answer and sends nothing.
  const mails = registrationMails(sender).length;
  assert.deepEqual((await publicApi('POST', newRegistrationToken(), '/renew')).body, { state: 'renewal_requested' });
  assert.deepEqual((await publicApi('POST', first, '/renew')).body, { state: 'renewal_requested' });
  await service.runCycle('test');
  assert.equal(registrationMails(sender).length, mails + 1);
  const second = latestToken(sender);
  assert.notEqual(second, first);
  assert.equal((await publicApi('GET', first)).status, 404, 'the old link is replaced');
  assert.equal((await publicApi('GET', second)).status, 200);
  // Asking again straight away is refused by the resend interval (still the same answer).
  await publicApi('POST', second, '/renew');
  await service.runCycle('test');
  assert.equal(registrationMails(sender).length, mails + 1);
  assert.equal(await ticketFor(inbound), null);
  assert.equal((await publicApi('POST', second, '', form({ name: 'Late Customer', email: sender, phone: '9100000040', serialNumber: 'REGSER0006' }))).status, 200);
  const ticket = await ticketFor(inbound);
  assert.deepEqual([ticket.registration.status, ticket.region, ticket.status], ['completed', 'Test Region North', 'Engineer Assigned']);
});

test('a failed registration email keeps the request pending and creates no ticket; it is retried, and an admin can resend it', { skip }, async () => {
  const sender = 'flaky@example.test';
  // Anything still queued from earlier tests is sent first, so the failure hits this email.
  await service.runCycle('test');
  smtpFailures.push(Object.assign(new Error('Could not reach the SMTP server (ETIMEDOUT).'), { retryable: true }));
  const { inbound } = await deliver({ from: sender, body: 'Repair needed' });
  let request = await requestFor(inbound);
  assert.equal(request.status, 'email_pending', 'not marked sent');
  assert.equal(registrationMails(sender).length, 0);
  assert.equal(await ticketFor(inbound), null);
  advanceMinutes(2);
  await service.runCycle('test');
  request = await requestFor(inbound);
  assert.deepEqual([request.status, registrationMails(sender).length], ['email_sent', 1]);
  assert.ok(request.lastSentAt);
  assert.equal((await publicApi('GET', latestToken(sender))).status, 200, 'the delivered link works');

  const other = 'refused@example.test';
  smtpFailures.push(Object.assign(new Error('The SMTP server refused the message (550).'), { retryable: false }));
  const refused = await deliver({ from: other, body: 'Repair needed' });
  assert.deepEqual([refused.request.status, refused.ticket], ['email_failed', null]);
  assert.ok(await B2CAuditEvent.exists({ registrationId: refused.request._id, action: 'registration_email_failed' }));
  const id = refused.request._id;
  // Admin resend: admin only, rate limited, audited.
  assert.equal((await staffApi(users.cmNorth, 'POST', `/registrations/${id}/actions/resend`)).status, 403);
  const tooSoon = await staffApi(users.admin, 'POST', `/registrations/${id}/actions/resend`);
  assert.equal(tooSoon.status, 429);
  advanceMinutes(config.registration.resendMinutes);
  const resent = await staffApi(users.admin, 'POST', `/registrations/${id}/actions/resend`);
  assert.equal(resent.status, 200);
  assert.deepEqual([resent.body.status, resent.body.sendCount], ['email_sent', 2]);
  assert.equal(registrationMails(other).length, 1);
  assert.ok(await B2CAuditEvent.exists({ registrationId: id, action: 'registration_resent', 'actor.name': 'admin' }));
  advanceMinutes(config.registration.resendMinutes);
  assert.equal((await staffApi(users.admin, 'POST', `/registrations/${id}/actions/resend`)).status, 200);
  advanceMinutes(config.registration.resendMinutes);
  const limit = await staffApi(users.admin, 'POST', `/registrations/${id}/actions/resend`);
  assert.equal(limit.status, 409, 'refused once the most links allowed were sent');
  assert.deepEqual((await staffApi(users.admin, 'GET', `/registrations/${id}`)).body.actions, ['create_ticket'], 'and no longer offered');
  assert.equal(await ticketFor(refused.inbound), null, 'resending never creates a ticket');
  assert.equal(ackMails(other).length, 0);
});

test('a database failure while saving the registration completes nothing and creates no ticket; the customer can submit again', { skip }, async () => {
  const failing = createB2CService({ ...serviceOptions, models: b2cModels, config, customerDirectory: { ...createCustomerDirectory(Customer), create: async () => { throw new Error('simulated write failure'); } } });
  const sender = 'write.failure@example.test';
  const { inbound } = await deliver({ from: sender, body: 'Repair needed' });
  const linkValue = latestToken(sender);
  const customers = await Customer.countDocuments();
  const details = form({ name: 'Write Failure', email: sender, phone: '9100000060', serialNumber: 'REGSER0008' });
  await assert.rejects(failing.submitRegistration(linkValue, details), /simulated write failure/);
  const request = await requestFor(inbound);
  assert.deepEqual([request.status, request.completedAt ?? null, request.submittedAt ?? null, request.submission ?? null], ['in_progress', null, null, null], 'not marked complete');
  assert.equal(await Customer.countDocuments(), customers);
  assert.equal(await ticketFor(inbound), null, 'no ticket');
  assert.equal((await publicApi('GET', linkValue)).status, 200, 'the link can be used again');
  assert.equal((await publicApi('POST', linkValue, '', details)).status, 200);
  assert.deepEqual([(await requestFor(inbound)).status, (await ticketFor(inbound)).region], ['completed', 'Test Region West']);
});

test('a crash after the registration is saved: the processing cycle creates the missing ticket once, without duplicating the registration', { skip }, async () => {
  // Ticket creation fails (the reference counter is unreachable) after the registration was saved.
  const crashing = createB2CService({ ...serviceOptions, config, models: { ...b2cModels, B2CCounter: { findOneAndUpdate: async () => { throw new Error('simulated crash before the ticket'); } } } });
  const sender = 'crash.after.save@example.test';
  const { inbound } = await deliver({ from: sender, body: 'Repair needed' });
  const customers = await Customer.countDocuments();
  const answer = await crashing.submitRegistration(latestToken(sender), form({ name: 'Crash Person', email: sender, phone: '9100000070', serialNumber: 'REGSER0009' }));
  assert.deepEqual(answer, { state: 'submitted', reference: null });
  let request = await requestFor(inbound);
  assert.deepEqual([request.status, request.ticketId, request.resumedAt], ['completed', null, null]);
  assert.equal(await Customer.countDocuments(), customers + 1);
  assert.equal(await ticketFor(inbound), null);
  await service.runCycle('test');
  const ticket = await ticketFor(inbound);
  assert.deepEqual([ticket.status, ticket.region, ticket.customerMatch.method], ['Engineer Assigned', 'Test Region North', 'registration']);
  request = await requestFor(inbound);
  assert.deepEqual([String(request.ticketId), Boolean(request.resumedAt)], [String(ticket._id), true]);
  await service.runCycle('test');
  assert.equal(await B2CEscalation.countDocuments({ sourceEmailId: inbound._id }), 1);
  assert.equal(await Customer.countDocuments(), customers + 1, 'the registration is not duplicated');
  assert.equal(ackMails(sender).length, 1);
});

test('a crash while the submission was being saved is finished by the processing cycle from the stored submission', { skip }, async () => {
  const sender = 'crash.during.save@example.test';
  const { inbound, request } = await deliver({ from: sender, body: 'Repair needed' });
  const { values } = validateRegistration(form({ name: 'Stalled Person', email: sender, phone: '9100000080', serialNumber: 'REGSER0010' }), { regions: REGIONS, now: now() });
  // The run stopped after the customer record was written (no transaction on this server)
  // and before the request was completed; its lock has expired.
  await Customer.create({ name: values.name, email: values.email, mobileNumber: values.phone, deviceSerialNumber: values.serialNumber });
  await B2CRegistrationRequest.updateOne({ _id: request._id }, { $set: { status: 'processing', submission: values, submittedAt: now(), lockedUntil: new Date(clock - 60_000) } });
  const customers = await Customer.countDocuments();
  await service.runCycle('test');
  const saved = await requestFor(inbound);
  assert.deepEqual([saved.status, saved.outcome.customerRecord], ['completed', 'existing'], 'the record written before the crash is reused');
  assert.equal(await Customer.countDocuments(), customers);
  const ticket = await ticketFor(inbound);
  assert.deepEqual([ticket.status, ticket.region], ['Engineer Assigned', 'Test Region West']);
});

test('the form sent twice at once saves one registration and creates one ticket', { skip }, async () => {
  const sender = 'double@example.test';
  const { inbound } = await deliver({ from: sender, body: 'Repair needed' });
  const customers = await Customer.countDocuments();
  const linkValue = latestToken(sender);
  const details = form({ name: 'Double Click', email: sender, phone: '9100000050', serialNumber: 'REGSER0007' });
  const results = await Promise.all([publicApi('POST', linkValue, '', details), publicApi('POST', linkValue, '', details)]);
  const [winner, loser] = results.sort((a, b) => a.status - b.status);
  assert.equal(winner.status, 200);
  assert.ok([409, 410].includes(loser.status), String(loser.status));
  assert.equal(await Customer.countDocuments(), customers + 1);
  assert.equal(await B2CEscalation.countDocuments({ sourceEmailId: inbound._id }), 1);
  assert.equal((await ticketFor(inbound)).status, 'Engineer Assigned');
  await service.runCycle('test');
  assert.equal(ackMails(sender).length, 1);
});

test('too many invalid submissions withdraw the link for an admin; no ticket is created', { skip }, async () => {
  const sender = 'guesser@example.test';
  const { inbound } = await deliver({ from: sender, body: 'Repair needed' });
  const linkValue = latestToken(sender);
  let last;
  for (let attempt = 0; attempt < config.registration.maxSubmitAttempts; attempt += 1) last = await publicApi('POST', linkValue, '', { ...form(), serialNumber: '!' });
  assert.deepEqual([last.status, last.body.code], [410, 'used']);
  const request = await requestFor(inbound);
  assert.deepEqual([request.status, request.reason], ['manual_review', 'too_many_failed_attempts']);
  assert.equal(await ticketFor(inbound), null);
});

test('one address gets a limited number of registration emails a day; beyond that the request waits for an admin, still without a ticket', { skip }, async () => {
  const sender = 'repeat.sender@example.test';
  const delivered = [];
  for (let index = 0; index <= config.registration.maxPerRecipientPerDay; index += 1) delivered.push(await deliver({ from: sender, subject: `Repair ${index}`, body: 'Repair needed' }));
  assert.equal(registrationMails(sender).length, config.registration.maxPerRecipientPerDay);
  assert.ok(delivered.every(item => item.ticket === null));
  const last = delivered.at(-1).request;
  assert.deepEqual([last.status, last.reason, last.sendCount], ['required', 'recipient_daily_limit', 0]);
  assert.ok(await B2CAuditEvent.exists({ registrationId: last._id, action: 'registration_not_requested' }));
  const listed = await staffApi(users.admin, 'GET', '/registrations?status=required');
  assert.ok(listed.body.items.some(item => item.id === String(last._id) && item.reason === 'recipient_daily_limit'));
});

test('a reply to the registration email joins the request, and the ticket\'s conversation once it is created', { skip }, async () => {
  const sender = 'replier@example.test';
  const { inbound, request } = await deliver({ from: sender, subject: 'Battery repair', body: 'Repair needed' });
  const [mail] = registrationMails(sender);
  sendEmail({ from: sender, subject: 'Re: Customer Registration Required', body: 'I will fill it in tonight.', inReplyTo: mail.messageId });
  await service.runCycle('test');
  const reply = await B2CInboundEmail.findOne({ inReplyTo: mail.messageId }).lean();
  assert.deepEqual([reply.status, reply.outcome], ['processed', 'appended_to_registration']);
  assert.equal(await B2CRegistrationRequest.countDocuments({ recipient: sender }), 1, 'no second request');
  assert.equal(registrationMails(sender).length, 1, 'no second link');
  assert.deepEqual((await requestFor(inbound)).relatedEmailIds.map(String), [String(reply._id)]);
  assert.equal(await B2CEscalation.countDocuments({ sourceEmailId: { $in: [inbound._id, reply._id] } }), 0);
  assert.equal((await publicApi('POST', latestToken(sender), '', form({ name: 'Reply Person', email: sender, phone: '9100000090', serialNumber: 'REGSER0011' }))).status, 200);
  const ticket = await ticketFor(inbound);
  assert.equal(String(ticket.registration.requestId), String(request._id));
  assert.equal(String((await B2CInboundEmail.findById(reply._id).lean()).ticketId), String(ticket._id));
  assert.ok(await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'customer_replied', 'details.inboundId': String(reply._id) }));
});

test('with registration turned off nothing changes; a link staff send for an existing ticket continues that ticket', { skip }, async () => {
  const plain = createB2CService({ ...serviceOptions, models: b2cModels, config: { ...config, registration: { ...config.registration, enabled: false } } });
  const sender = 'disabled@example.test';
  const { ticket, request } = await deliver({ from: sender, body: 'Repair needed' }, plain);
  assert.deepEqual([ticket.status, ticket.registration?.status, request], ['Pending Triage', undefined, null]);
  assert.equal(ticket.acknowledgement.status, 'skipped', 'existing policy for unmatched senders');
  const detail = await staffApi(users.admin, 'GET', `/tickets/${ticket._id}`);
  assert.equal(detail.body.allowedActions.includes('send_registration'), true);
  // Staff ask the customer of this existing ticket to register: the same ticket continues.
  const tickets = await B2CEscalation.countDocuments();
  assert.equal((await staffApi(users.admin, 'POST', `/tickets/${ticket._id}/actions/send_registration`)).status, 200);
  const linked = await B2CRegistrationRequest.findOne({ ticketId: ticket._id }).lean();
  assert.equal(linked.reference, ticket.reference);
  assert.equal((await publicApi('POST', latestToken(sender), '', form({ name: 'Disabled Person', email: sender, phone: '9100000095', serialNumber: 'REGSER0012' }))).status, 200);
  const continued = await reload(ticket);
  assert.deepEqual([continued.status, continued.region, continued.registration.status], ['Engineer Assigned', 'Test Region West', 'completed']);
  assert.equal(await B2CEscalation.countDocuments(), tickets, 'no second ticket');

  const app = express();
  app.use(express.json());
  app.use('/api/b2c/public', createB2CPublicRouter({ service, logger: silent, limits: { view: 2 } }));
  const limited = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const url = `http://127.0.0.1:${limited.address().port}/api/b2c/public/registration/${newRegistrationToken()}`;
  const statuses = [];
  for (let index = 0; index < 3; index += 1) statuses.push((await fetch(url)).status);
  limited.close();
  assert.deepEqual(statuses, [404, 404, 429]);
});

test('access: public routes expose no staff data; B2B accounts and anonymous users cannot reach B2C staff routes', { skip }, async () => {
  assert.equal((await call('GET', '/api/b2c/public/tickets')).status, 401, 'nothing else is public');
  assert.equal((await staffApi(null, 'GET', '/tickets')).status, 401);
  assert.equal((await staffApi(users.corporate, 'GET', '/tickets')).status, 403);
  assert.equal((await staffApi(users.corporate, 'GET', '/registrations')).status, 403);
  const request = await B2CRegistrationRequest.findOne({ status: 'manual_review', ticketId: null }).lean();
  assert.equal((await staffApi(users.corporate, 'GET', `/registrations/${request._id}`)).status, 403);
  assert.equal((await staffApi(users.admin, 'GET', `/registrations/${new mongoose.Types.ObjectId()}`)).status, 404);
  const dashboard = await staffApi(users.admin, 'GET', '/dashboard');
  assert.ok(dashboard.body.registrations.awaitingCustomer > 0 && dashboard.body.registrations.needDecision > 0);
  assert.equal((await staffApi(users.cmNorth, 'GET', '/dashboard')).body.registrations, undefined, 'admins only');
});

test('tickets created before registration under the earlier flow are reported read-only; tickets created after registration or by staff are not', { skip }, async () => {
  // As the earlier flow left it: the ticket created on arrival, its request opened with it.
  const plain = createB2CService({ ...serviceOptions, models: b2cModels, config: { ...config, registration: { ...config.registration, enabled: false } } });
  const { ticket } = await deliver({ from: 'legacy@example.test', body: 'Repair needed' }, plain);
  const legacy = await B2CRegistrationRequest.create({ ticketId: ticket._id, reference: ticket.reference, sourceEmailId: ticket.sourceEmailId, trigger: 'not_found', recipient: 'legacy@example.test', status: 'email_sent' });
  await B2CEscalation.updateOne({ _id: ticket._id }, { $set: { registration: { status: 'email_sent', requestId: legacy._id } } });
  await B2CAuditEvent.create({ ticketId: ticket._id, reference: ticket.reference, action: 'registration_requested', actor: { name: 'System', role: 'system' }, details: { trigger: 'not_found', manual: false } });
  const snapshot = JSON.stringify([await reload(ticket), await B2CRegistrationRequest.findById(legacy._id).lean()]);
  const found = await findPrematureTickets(b2cModels);
  assert.deepEqual(found.map(item => [item.reference, item.state, item.registrationStatus]), [[ticket.reference, 'awaiting_registration', 'email_sent']]);
  assert.ok(!JSON.stringify(found).includes('legacy@example.test'), 'no customer details');
  assert.equal(JSON.stringify([await reload(ticket), await B2CRegistrationRequest.findById(legacy._id).lean()]), snapshot, 'nothing changed');
});
