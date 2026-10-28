import { ConnectorError } from './connectorErrors.js';
import { createTestEmailAdapter } from './testEmailAdapter.js';
import { createMicrosoftGraphEmailAdapter } from './microsoftGraphEmailAdapter.js';
import { createImapEmailAdapter } from './imapEmailAdapter.js';

// Email connector contract. Each provider adapter implements:
//
//   provider        'test' | 'microsoft_graph' | 'imap'
//   mode            'test' (no real email) | 'live'
//   isConfigured()  true when the credentials it needs are present
//   fetchNew({ inbox, limit }) -> [RawEmail]
//   markProcessed({ inbox, providerMessageId })   called once a message is safely stored
//   send({ inbox, to, subject, text, messageId, reference }) -> { providerMessageId }
//
// RawEmail: { providerMessageId, internetMessageId, inReplyTo, references,
//   from: { address, name }, to: [address], cc: [address], subject, text, html,
//   receivedAt, headers: { name: value }, attachments: [{ filename, contentType, size, content: Buffer }] }
//
// Receive-only providers ('imap') implement no send(): customer email for
// their inboxes is recorded as not sent instead of being delivered.
//
// Credentials are read from the backend environment only and never stored in
// MongoDB or returned to the browser.
export const RECEIVE_ONLY_PROVIDERS = ['imap'];
export const isReceiveOnly = inbox => RECEIVE_ONLY_PROVIDERS.includes(inbox?.provider);

export function createEmailConnectors({ config, fetchImpl = globalThis.fetch, testAdapter, imapAdapter } = {}) {
  const connectors = {
    microsoft_graph: createMicrosoftGraphEmailAdapter({ ...config.graph, fetchImpl }),
    imap: imapAdapter || createImapEmailAdapter(config.imap || {}),
  };
  // The test adapter is never available in production unless explicitly allowed.
  if (config.allowTestAdapters) connectors.test = testAdapter || createTestEmailAdapter();
  const lookup = provider => {
    const connector = connectors[provider];
    if (!connector) throw new ConnectorError(`Email provider "${provider}" is not available in this environment.`, { retryable: false, connector: 'email' });
    return connector;
  };
  const describeConnector = provider => {
    const connector = connectors[provider];
    if (!connector) return { provider, mode: 'disabled', configured: false };
    return { provider: connector.provider, mode: connector.isConfigured() ? connector.mode : 'not_configured', configured: connector.isConfigured() };
  };
  return {
    forInbox: inbox => lookup(inbox?.provider),
    forOutbound(inbox) {
      if (isReceiveOnly(inbox)) throw new ConnectorError(`Email provider "${inbox.provider}" only reads the mailbox; it cannot send email.`, { retryable: false, connector: 'email' });
      return lookup(inbox?.provider);
    },
    canSend: inbox => !isReceiveOnly(inbox),
    get(provider) { return connectors[provider] || null; },
    describe: inbox => describeConnector(inbox?.provider),
    // null for a receive-only inbox: nothing sends its customer email.
    describeOutbound: inbox => (isReceiveOnly(inbox) ? null : describeConnector(inbox?.provider)),
  };
}
