import { ConnectorError } from './connectorErrors.js';
import { createTestEmailAdapter } from './testEmailAdapter.js';
import { createMicrosoftGraphEmailAdapter } from './microsoftGraphEmailAdapter.js';

// Email connector contract. Each provider adapter implements:
//
//   provider        'test' | 'microsoft_graph'
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
// Credentials are read from the backend environment only and never stored in
// MongoDB or returned to the browser.

export function createEmailConnectors({ config, fetchImpl = globalThis.fetch, testAdapter } = {}) {
  const connectors = {
    microsoft_graph: createMicrosoftGraphEmailAdapter({ ...config.graph, fetchImpl }),
  };
  // The test adapter is never available in production unless explicitly allowed.
  if (config.allowTestAdapters) connectors.test = testAdapter || createTestEmailAdapter();
  return {
    forInbox(inbox) {
      const connector = connectors[inbox?.provider];
      if (!connector) throw new ConnectorError(`Email provider "${inbox?.provider}" is not available in this environment.`, { retryable: false, connector: 'email' });
      return connector;
    },
    get(provider) { return connectors[provider] || null; },
    describe(inbox) {
      const connector = connectors[inbox?.provider];
      if (!connector) return { provider: inbox?.provider, mode: 'disabled', configured: false };
      return { provider: connector.provider, mode: connector.isConfigured() ? connector.mode : 'not_configured', configured: connector.isConfigured() };
    },
  };
}
