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
    // Seeded into the default settings as the single starting inbox.
    testInboxAddress: (env.B2C_TEST_INBOX_ADDRESS || 'escalations@b2c-inbox.test').toLowerCase(),
    // Domain for the Message-ID of outbound mail.
    messageIdDomain: env.B2C_MESSAGE_ID_DOMAIN || 'sabora.local',
    demoAccounts: !production && env.B2C_DEMO_ACCOUNTS !== 'false',
  };
}
