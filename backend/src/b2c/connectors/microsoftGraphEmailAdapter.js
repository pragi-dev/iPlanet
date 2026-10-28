import { ConnectorError, classifyHttpFailure } from './connectorErrors.js';

// Microsoft 365 mailbox connector using documented Microsoft Graph v1.0 endpoints:
//   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token   (client credentials)
//   GET  /users/{mailbox}/mailFolders/inbox/messages                    (list unread)
//   GET  /users/{mailbox}/messages/{id}/attachments                     (file attachments)
//   PATCH /users/{mailbox}/messages/{id}  { isRead: true }             (mark processed)
//   POST /users/{mailbox}/sendMail                                      (send)
// It needs an Entra ID app registration with the Mail.ReadWrite and Mail.Send
// application permissions, ideally limited to the TCM mailboxes with an
// application access policy. It has NOT been verified against a TCM tenant:
// TCM has not confirmed its email provider or supplied credentials.
const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,internetMessageHeaders';

export function createMicrosoftGraphEmailAdapter({ tenantId, clientId, clientSecret, timeoutMs = 20000, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let token = null;
  const configured = () => Boolean(tenantId && clientId && clientSecret);

  async function call(url, init = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ConnectorError(`Microsoft Graph request failed: ${error.name === 'TimeoutError' ? 'timed out' : 'network error'}`, { retryable: true, connector: 'microsoft_graph' });
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      // Only the error code is kept; Graph error messages can echo request data.
      const code = body?.error?.code || body?.error || 'unknown_error';
      throw new ConnectorError(`Microsoft Graph returned HTTP ${response.status} (${String(code).slice(0, 80)})`, { ...classifyHttpFailure(response.status), status: response.status, connector: 'microsoft_graph' });
    }
    return response.status === 202 || response.status === 204 ? null : response.json();
  }

  async function accessToken() {
    if (!configured()) throw new ConnectorError('Microsoft Graph credentials are not configured (B2C_GRAPH_TENANT_ID, B2C_GRAPH_CLIENT_ID, B2C_GRAPH_CLIENT_SECRET).', { retryable: false, connector: 'microsoft_graph' });
    if (token && token.expiresAt - 60_000 > now()) return token.value;
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
    const result = await call(`${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    token = { value: result.access_token, expiresAt: now() + Number(result.expires_in || 3600) * 1000 };
    return token.value;
  }

  const graph = async (path, init = {}) => call(`${GRAPH}${path}`, { ...init, headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.headers || {}) } });
  const mailboxPath = inbox => `/users/${encodeURIComponent(inbox.address)}`;
  const header = (headers, name) => headers.find(item => item.name?.toLowerCase() === name)?.value;

  return {
    provider: 'microsoft_graph',
    mode: 'live',
    isConfigured: configured,
    async fetchNew({ inbox, limit = 25 }) {
      const query = new URLSearchParams({ $filter: 'isRead eq false', $top: String(Math.min(limit, 50)), $select: SELECT });
      const page = await graph(`${mailboxPath(inbox)}/mailFolders/inbox/messages?${query}`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      const messages = (page?.value || []).sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime));
      const result = [];
      for (const message of messages) {
        const headers = message.internetMessageHeaders || [];
        let attachments = [];
        if (message.hasAttachments) {
          const list = await graph(`${mailboxPath(inbox)}/messages/${encodeURIComponent(message.id)}/attachments`);
          attachments = (list?.value || []).filter(item => !item.isInline).map(item => item['@odata.type'] === '#microsoft.graph.fileAttachment'
            ? { filename: item.name, contentType: item.contentType, size: item.size, content: item.contentBytes ? Buffer.from(item.contentBytes, 'base64') : null }
            // Item and reference attachments (attached emails, cloud links) are recorded but not downloaded.
            : { filename: item.name, contentType: item.contentType, size: item.size, content: null });
        }
        result.push({
          providerMessageId: message.id,
          internetMessageId: message.internetMessageId,
          inReplyTo: header(headers, 'in-reply-to'),
          references: header(headers, 'references'),
          from: { address: message.from?.emailAddress?.address, name: message.from?.emailAddress?.name },
          to: (message.toRecipients || []).map(item => item.emailAddress?.address),
          cc: (message.ccRecipients || []).map(item => item.emailAddress?.address),
          subject: message.subject,
          text: message.body?.contentType === 'text' ? message.body.content : '',
          html: message.body?.contentType === 'html' ? message.body.content : '',
          receivedAt: message.receivedDateTime,
          headers: Object.fromEntries(headers.filter(item => /^(auto-submitted|precedence|x-autoreply|x-autorespond|x-auto-response-suppress)$/i.test(item.name || '')).map(item => [item.name.toLowerCase(), item.value])),
          attachments,
        });
      }
      return result;
    },
    async markProcessed({ inbox, providerMessageId }) {
      await graph(`${mailboxPath(inbox)}/messages/${encodeURIComponent(providerMessageId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isRead: true }) });
    },
    async send({ inbox, to, subject, text, reference }) {
      const message = { subject, body: { contentType: 'Text', content: text }, toRecipients: [{ emailAddress: { address: to } }], internetMessageHeaders: reference ? [{ name: 'X-Sabora-Reference', value: reference }] : undefined };
      await graph(`${mailboxPath(inbox)}/sendMail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }) });
      // sendMail returns 202 with no body, so Graph provides no message id.
      return { providerMessageId: null };
    },
  };
}
