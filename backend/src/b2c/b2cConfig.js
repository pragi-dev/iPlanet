import path from 'node:path';
import { fileURLToPath } from 'node:url';

// B2C escalation settings that come from the environment: credentials,
// limits and scheduling. Business rules (inboxes, identifier formats,
// classification, workflow paths, templates) are stored in B2CSettings so
// TCM can change them without a deploy.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

// Customer acknowledgements sent from a separate company address (e.g.
// noreply@aavoraa.com) over authenticated SMTP. Configured separately from the
// IMAP inbox: different account, different credentials. Off unless enabled.
// `unmatchedPolicy`: 'verified' acknowledges only a matched (registered) customer,
// at their registered address; 'sender' also acknowledges an unmatched sender.
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export function loadAckConfig(env = process.env) {
  const port = Number.parseInt(env.B2C_ACK_SMTP_PORT || '465', 10);
  const fromEmail = String(env.B2C_ACK_FROM_EMAIL || '').trim().toLowerCase();
  return {
    enabled: env.B2C_ACK_EMAIL_ENABLED === 'true',
    fromEmail: EMAIL.test(fromEmail) ? fromEmail : '',
    fromName: String(env.B2C_ACK_FROM_NAME || '').replace(/[\r\n"<>]/g, '').trim().slice(0, 80),
    companyName: String(env.B2C_ACK_COMPANY_NAME || 'iPlanet').replace(/[\r\n]/g, '').trim().slice(0, 80),
    unmatchedPolicy: env.B2C_ACK_UNMATCHED_POLICY === 'sender' ? 'sender' : 'verified',
    smtp: {
      host: String(env.B2C_ACK_SMTP_HOST || '').trim(),
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      // Port 465 is implicit TLS; 587 must upgrade with STARTTLS.
      secure: env.B2C_ACK_SMTP_SECURE === undefined || env.B2C_ACK_SMTP_SECURE === '' ? port === 465 : env.B2C_ACK_SMTP_SECURE === 'true',
      user: String(env.B2C_ACK_SMTP_USER || '').trim(),
      pass: env.B2C_ACK_SMTP_PASS || '',
      timeoutMs: positiveInt(env.B2C_ACK_SMTP_TIMEOUT_MS, 20000, 120000),
    },
  };
}

// Names the missing acknowledgement variables; never returns their values.
export function validateAckConfig(ack) {
  const missing = [];
  if (!ack.fromEmail) missing.push('B2C_ACK_FROM_EMAIL');
  if (!ack.smtp.host) missing.push('B2C_ACK_SMTP_HOST');
  if (!ack.smtp.port) missing.push('B2C_ACK_SMTP_PORT');
  if (!ack.smtp.user) missing.push('B2C_ACK_SMTP_USER');
  if (!ack.smtp.pass) missing.push('B2C_ACK_SMTP_PASS');
  return { configured: !missing.length, missing };
}

// Incoming mail from an IMAP mailbox (e.g. MilesWeb). IMAP only reads mail;
// acknowledgements are sent by the separate sender above.
export function loadImapConfig(env = process.env) {
  const port = Number.parseInt(env.IMAP_PORT || '993', 10);
  return {
    host: String(env.IMAP_HOST || '').trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    // Port 993 is implicit TLS; 143 upgrades with STARTTLS.
    secure: env.IMAP_SECURE === undefined || env.IMAP_SECURE === '' ? port === 993 : env.IMAP_SECURE === 'true',
    user: String(env.IMAP_USER || '').trim(),
    pass: env.IMAP_PASS || '',
    mailbox: String(env.IMAP_MAILBOX || 'INBOX').trim(),
    connectionTimeoutMs: positiveInt(env.IMAP_CONNECTION_TIMEOUT_MS, 15000, 120000),
    socketTimeoutMs: positiveInt(env.IMAP_SOCKET_TIMEOUT_MS, 60000, 300000),
    // Larger messages are imported from their headers only, with a note in the body.
    maxMessageBytes: positiveInt(env.IMAP_MAX_MESSAGE_MB, 40, 100) * MB,
  };
}

// Names the missing IMAP variables; never returns their values.
export function validateImapConfig(imap) {
  const missing = [];
  if (!imap.host) missing.push('IMAP_HOST');
  if (!imap.port) missing.push('IMAP_PORT');
  if (!imap.user) missing.push('IMAP_USER');
  if (!imap.pass) missing.push('IMAP_PASS');
  return { configured: !missing.length, missing };
}

// Customer registration links, sent when an email's sender cannot be matched to a
// registered customer. Off unless enabled. `portalUrl` is the public frontend that serves
// /b2c/customer-registration/:token; in production it must be HTTPS or no link is sent.
export function loadRegistrationConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const portalUrl = String(env.B2C_REGISTRATION_PORTAL_URL || '').trim().replace(/\/+$/, '');
  let valid = false;
  try { const url = new URL(portalUrl); valid = url.protocol === 'https:' || (!production && url.protocol === 'http:'); } catch { valid = false; }
  return {
    enabled: env.B2C_REGISTRATION_ENABLED === 'true',
    portalUrl: valid ? portalUrl : '',
    ttlHours: positiveInt(env.B2C_REGISTRATION_TTL_HOURS, 72, 720),
    // Links sent for one request (the first and any resends), and the wait between them.
    maxSends: positiveInt(env.B2C_REGISTRATION_MAX_SENDS, 3, 10),
    resendMinutes: positiveInt(env.B2C_REGISTRATION_RESEND_MINUTES, 15, 1440),
    // Registration emails one address may receive in 24 hours across all its tickets.
    maxPerRecipientPerDay: positiveInt(env.B2C_REGISTRATION_MAX_PER_RECIPIENT_DAY, 3, 50),
    // Failed form submissions a link allows before it is withdrawn for manual review.
    maxSubmitAttempts: positiveInt(env.B2C_REGISTRATION_MAX_SUBMIT_ATTEMPTS, 10, 50),
    // A purchase date further than this from the one on the device record is checked by staff.
    purchaseDateToleranceDays: positiveInt(env.B2C_REGISTRATION_PURCHASE_DATE_TOLERANCE_DAYS, 7, 365),
  };
}

export function loadB2CConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  return {
    // Minutes between inbox polls; 0 disables the in-process poller (use the cron endpoint).
    pollMinutes: env.B2C_EMAIL_POLL_MINUTES === '0' ? 0 : positiveInt(env.B2C_EMAIL_POLL_MINUTES, 2, 1440),
    // Shared secret for POST /api/internal/b2c/run; unset disables the endpoint.
    cronSecret: env.B2C_CRON_SECRET || '',
    referencePrefix: /^[A-Z]{2,6}$/.test(env.B2C_REFERENCE_PREFIX || '') ? env.B2C_REFERENCE_PREFIX : 'B2C',
    maxProcessingAttempts: positiveInt(env.B2C_MAX_PROCESSING_ATTEMPTS, 5, 20),
    maxSendAttempts: positiveInt(env.B2C_MAX_SEND_ATTEMPTS, 5, 20),
    maxCrmAttempts: positiveInt(env.B2C_MAX_CRM_ATTEMPTS, 5, 20),
    pollBatchSize: positiveInt(env.B2C_POLL_BATCH_SIZE, 25, 100),
    // Attachments are kept outside the public /uploads folder and served only
    // through the authorised download endpoint.
    attachmentDir: env.B2C_ATTACHMENT_DIR || path.resolve(__dirname, '../../storage/b2c-attachments'),
    maxAttachmentBytes: positiveInt(env.B2C_MAX_ATTACHMENT_MB, 10, 50) * MB,
    maxAttachmentsPerEmail: positiveInt(env.B2C_MAX_ATTACHMENTS, 10, 50),
    maxBodyChars: 100_000,
    // Test adapters never run in production unless explicitly allowed (e.g. a staging environment).
    allowTestAdapters: !production || env.B2C_ALLOW_TEST_ADAPTERS === 'true',
    crmProvider: ['test', 'none'].includes(env.B2C_CRM_PROVIDER) ? env.B2C_CRM_PROVIDER : 'none',
    crmTimeoutMs: positiveInt(env.B2C_CRM_TIMEOUT_MS, 15000, 120000),
    graph: {
      tenantId: env.B2C_GRAPH_TENANT_ID || '',
      clientId: env.B2C_GRAPH_CLIENT_ID || '',
      clientSecret: env.B2C_GRAPH_CLIENT_SECRET || '',
      timeoutMs: positiveInt(env.B2C_GRAPH_TIMEOUT_MS, 20000, 120000),
    },
    imap: loadImapConfig(env),
    ack: loadAckConfig(env),
    registration: loadRegistrationConfig(env),
    // Seeded into the default settings as the single starting inbox.
    testInboxAddress: (env.B2C_TEST_INBOX_ADDRESS || 'escalations@b2c-inbox.test').toLowerCase(),
    // Domain for the Message-ID of outbound mail (Graph and test inboxes).
    messageIdDomain: env.B2C_MESSAGE_ID_DOMAIN || 'sabora.local',
    demoAccounts: !production && env.B2C_DEMO_ACCOUNTS !== 'false',
  };
}
