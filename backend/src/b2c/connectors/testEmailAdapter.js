import crypto from 'node:crypto';

// TEST ADAPTER — NOT A LIVE INTEGRATION.
// An in-memory mailbox used for development and automated tests. It neither
// receives nor sends real email: messages are injected through the B2C test
// endpoint (or by tests) and "sent" messages are kept in memory only. It is
// disabled in production unless B2C_ALLOW_TEST_ADAPTERS=true.
export function createTestEmailAdapter() {
  const inboxes = new Map();
  const sent = [];
  const mailbox = address => {
    const key = String(address).toLowerCase();
    if (!inboxes.has(key)) inboxes.set(key, []);
    return inboxes.get(key);
  };
  return {
    provider: 'test',
    mode: 'test',
    isConfigured: () => true,
    // Adds a message to a test inbox and returns its provider message id.
    inject(address, message) {
      const providerMessageId = message.providerMessageId || `test-${crypto.randomUUID()}`;
      mailbox(address).push({ ...message, providerMessageId, read: false });
      return providerMessageId;
    },
    async fetchNew({ inbox, limit = 25 }) {
      return mailbox(inbox.address).filter(message => !message.read).slice(0, limit).map(({ read, ...message }) => ({ ...message }));
    },
    async markProcessed({ inbox, providerMessageId }) {
      const message = mailbox(inbox.address).find(item => item.providerMessageId === providerMessageId);
      if (message) message.read = true;
    },
    async send({ inbox, to, subject, text, messageId, reference }) {
      const providerMessageId = `test-sent-${crypto.randomUUID()}`;
      sent.unshift({ providerMessageId, from: inbox.address, to, subject, text, messageId, reference, sentAt: new Date().toISOString() });
      sent.splice(200);
      return { providerMessageId };
    },
    sentMessages: () => sent.map(message => ({ ...message })),
    reset() { inboxes.clear(); sent.length = 0; },
  };
}
