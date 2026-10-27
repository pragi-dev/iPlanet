// Unit tests for incoming IMAP email. The IMAP server is a mock: no network,
// MilesWeb account or credentials are needed. Messages are real MIME text, so
// parsing is exercised with the real parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadImapConfig, validateImapConfig, loadB2CConfig } from '../b2cConfig.js';
import { createImapEmailAdapter, classifyImapError } from './imapEmailAdapter.js';
import { createEmailConnectors } from './emailConnector.js';
import { validateSettingsUpdate } from '../settingsValidation.js';
import { defaultSettings } from '../b2cDefaults.js';
import { normaliseInboundEmail } from '../emailContent.js';

const SECRET = 'mock-imap-password-123';
const MAILBOX = 'test1@aavoraa.com';
const ENV = { IMAP_HOST: 'mail.aavoraa.com', IMAP_USER: MAILBOX, IMAP_PASS: SECRET };
const INBOX = { key: 'aavoraa', address: MAILBOX, provider: 'imap' };

export function mime({ from = '"Test Customer" <customer@example.test>', subject = 'Repair delayed', messageId = '<imap-1@example.test>', body = 'Case ID: TEST-CASE-0001\r\nSerial No: TESTSERIAL01', headers = '', attachment = true } = {}) {
  const parts = [`--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`];
  if (attachment) parts.push('--b1\r\nContent-Type: application/pdf; name="invoice.pdf"\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n');
  parts.push('--b1\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename="logo.png"\r\nContent-ID: <logo@x>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n');
  return `From: ${from}\r\nTo: ${MAILBOX}\r\nSubject: ${subject}\r\nMessage-ID: ${messageId}\r\nDate: Fri, 23 Oct 2026 10:00:00 +0530\r\n${headers}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n${parts.join('')}--b1--\r\n`;
}

// In-memory stand-in for an IMAP server and the ImapFlow client.
export function fakeImap({ messages = [], uidValidity = 7, connectError = null } = {}) {
  const state = { messages: messages.map(item => ({ seen: false, ...item })), logins: 0, logouts: 0, options: null, folder: null, connectError };
  const client = {
    usable: false,
    mailbox: null,
    on() {},
    async connect() { state.logins += 1; if (state.connectError) throw state.connectError; client.usable = true; },
    async mailboxOpen(path) { state.folder = path; client.mailbox = { path, uidValidity: BigInt(uidValidity) }; },
    async search(query) { assert.deepEqual(query, { seen: false }); return state.messages.filter(item => !item.seen).map(item => item.uid).reverse(); },
    async fetchOne(uid, query) {
      const message = state.messages.find(item => String(item.uid) === String(uid));
      if (!message) return false;
      if (query.source) return { uid: message.uid, source: Buffer.from(message.source) };
      return { uid: message.uid, size: message.size ?? Buffer.byteLength(message.source), internalDate: new Date('2026-10-23T04:30:00Z'), envelope: message.envelope || {} };
    },
    async messageFlagsAdd(uid, flags, options) {
      assert.deepEqual([flags, options], [['\\Seen'], { uid: true }]);
      state.messages.find(item => String(item.uid) === String(uid)).seen = true;
    },
    async logout() { state.logouts += 1; client.usable = false; },
    close() { client.usable = false; },
  };
  return { state, client, createClient: options => { state.options = options; return client; } };
}

test('IMAP settings come from IMAP_* only and report what is missing without values', () => {
  const imap = loadImapConfig(ENV);
  assert.deepEqual([imap.host, imap.port, imap.secure, imap.user, imap.pass, imap.mailbox], ['mail.aavoraa.com', 993, true, MAILBOX, SECRET, 'INBOX']);
  assert.deepEqual(validateImapConfig(imap), { configured: true, missing: [] });
  assert.equal(loadImapConfig({ ...ENV, IMAP_USER: 'other@aavoraa.com', IMAP_PORT: '143' }).user, 'other@aavoraa.com');
  assert.equal(loadImapConfig({ ...ENV, IMAP_PORT: '143' }).secure, false);
  const missing = validateImapConfig(loadImapConfig({}));
  assert.equal(missing.configured, false);
  assert.deepEqual(missing.missing, ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASS']);
  // SMTP variables are no longer read as a fallback.
  assert.equal(validateImapConfig(loadImapConfig({ SMTP_HOST: 'mail.aavoraa.com', SMTP_USER: MAILBOX, SMTP_PASS: SECRET })).configured, false);
  assert.doesNotMatch(JSON.stringify(validateImapConfig(imap)), new RegExp(SECRET));
  assert.equal(loadB2CConfig(ENV).imap.host, 'mail.aavoraa.com');
});

test('unread messages are fetched oldest first without marking them read, then marked read once stored', async () => {
  const server = fakeImap({ messages: [
    { uid: 11, source: mime() },
    { uid: 12, source: mime({ messageId: '<imap-2@example.test>', subject: 'Second', attachment: false, headers: 'Auto-Submitted: auto-replied\r\n' }) },
    { uid: 10, source: mime({ messageId: '<old@example.test>' }), seen: true },
  ] });
  const adapter = createImapEmailAdapter(loadImapConfig(ENV), { createClient: server.createClient, idleCloseMs: 5 });
  const messages = await adapter.fetchNew({ inbox: INBOX, limit: 25 });
  assert.deepEqual(messages.map(item => item.providerMessageId), ['7:11', '7:12']);
  assert.ok(server.state.messages.every(item => item.uid === 10 || !item.seen), 'fetching leaves messages unread');
  const [first, second] = messages;
  assert.deepEqual(first.from, { address: 'customer@example.test', name: 'Test Customer' });
  assert.equal(first.internetMessageId, '<imap-1@example.test>');
  assert.deepEqual(first.to, [MAILBOX]);
  assert.match(first.text, /Case ID: TEST-CASE-0001/);
  assert.equal(new Date(first.receivedAt).toISOString(), '2026-10-23T04:30:00.000Z');
  assert.deepEqual(first.attachments.map(item => [item.filename, item.contentType, item.content.toString()]), [['invoice.pdf', 'application/pdf', '%PDF-1.4\n']], 'the inline logo is not an attachment');
  assert.equal(second.headers['auto-submitted'], 'auto-replied');
  // The normaliser turns that header into an auto-reply, so it will not create a ticket.
  assert.equal(normaliseInboundEmail(second).autoGenerated, 'auto_submitted');

  await adapter.markProcessed({ inbox: INBOX, providerMessageId: '7:11' });
  await adapter.markProcessed({ inbox: INBOX, providerMessageId: '7:12' });
  assert.ok(server.state.messages.every(item => item.seen));
  assert.equal(server.state.logins, 1, 'one login for the poll and its markProcessed calls');
  // A recreated mailbox (new UIDVALIDITY) never flags the wrong message.
  server.state.messages.push({ uid: 13, seen: false, source: mime({ messageId: '<imap-3@example.test>' }) });
  await adapter.markProcessed({ inbox: INBOX, providerMessageId: '6:13' });
  assert.equal(server.state.messages.at(-1).seen, false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(server.state.logouts, 1, 'the idle connection is closed');

  const options = server.state.options;
  assert.deepEqual([options.host, options.port, options.secure, options.auth.user, options.auth.pass, options.logger], ['mail.aavoraa.com', 993, true, MAILBOX, SECRET, false]);
  assert.equal(options.tls.minVersion, 'TLSv1.2');
  assert.ok(options.connectionTimeout > 0 && options.socketTimeout > 0);
  assert.equal(server.state.folder, 'INBOX');
});

test('oversized messages become header-only emails so a ticket is still created', async () => {
  const server = fakeImap({ messages: [{ uid: 5, source: 'x', size: 60 * 1048576, envelope: { messageId: '<big@example.test>', subject: 'Huge video', from: [{ address: 'customer@example.test', name: 'C' }], to: [{ address: MAILBOX }] } }] });
  const [message] = await createImapEmailAdapter(loadImapConfig(ENV), { createClient: server.createClient }).fetchNew({ inbox: INBOX });
  assert.deepEqual([message.internetMessageId, message.subject, message.from.address, message.attachments.length], ['<big@example.test>', 'Huge video', 'customer@example.test', 0]);
  assert.match(message.text, /60 MB, over the import limit/);
});

test('IMAP failures are classified and never echo credentials; a mismatched inbox address is refused', async () => {
  const login = Object.assign(new Error(`Authentication failed for ${SECRET}`), { authenticationFailed: true });
  const classified = classifyImapError(login);
  assert.deepEqual([classified.retryable, classified.message], [false, 'IMAP login failed. Check the mailbox user name and password.']);
  assert.equal(classifyImapError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })).retryable, true);
  assert.equal(classifyImapError(Object.assign(new Error('Mailbox does not exist'), { mailboxMissing: true })).retryable, false);
  assert.match(classifyImapError(new Error('unable to verify the first certificate')).message, /secure connection failed/);

  const server = fakeImap({ connectError: login });
  const adapter = createImapEmailAdapter(loadImapConfig(ENV), { createClient: server.createClient });
  await assert.rejects(adapter.fetchNew({ inbox: INBOX }), error => error.retryable === false && !error.message.includes(SECRET));
  await assert.rejects(adapter.verify(), /IMAP login failed/);
  server.state.connectError = null;
  assert.deepEqual(await adapter.verify(), { ok: true });

  await assert.rejects(adapter.fetchNew({ inbox: { ...INBOX, address: 'someone-else@aavoraa.com' } }), error => error.retryable === false && /not the IMAP mailbox/.test(error.message));
  const unconfigured = createImapEmailAdapter(loadImapConfig({}), { createClient: server.createClient });
  await assert.rejects(unconfigured.fetchNew({ inbox: INBOX }), error => error.retryable === false && /IMAP is not configured/.test(error.message));
});

test('an IMAP inbox reads through IMAP and is receive-only', () => {
  const connectors = createEmailConnectors({ config: loadB2CConfig(ENV) });
  assert.equal(connectors.forInbox(INBOX).provider, 'imap');
  assert.equal(connectors.canSend(INBOX), false);
  assert.throws(() => connectors.forOutbound(INBOX), error => error.retryable === false && /cannot send/.test(error.message));
  assert.equal(connectors.get('smtp'), null, 'no SMTP connector exists');
  assert.deepEqual(connectors.describe(INBOX), { provider: 'imap', mode: 'live', configured: true });
  assert.equal(connectors.describeOutbound(INBOX), null);
  const settings = defaultSettings({ testInboxAddress: 'escalations@b2c-inbox.test' });
  const update = validateSettingsUpdate({ inboxes: [{ key: 'aavoraa', address: MAILBOX, displayName: 'Aavoraa support', provider: 'imap', outboundProvider: 'smtp', enabled: true }] }, settings);
  assert.equal(update.inboxes[0].provider, 'imap');
  assert.equal('outboundProvider' in update.inboxes[0], false, 'the retired SMTP setting is dropped');
});
