import { validateAckConfig } from '../b2cConfig.js';
import { ConnectorError } from './connectorErrors.js';

// Sends customer acknowledgements and registration links from the company address through
// Brevo's HTTPS API, for hosts that block outgoing SMTP ports (Render's free plan blocks 25,
// 465 and 587). Same interface as smtpAckSender.js; used when B2C_ACK_API_KEY is set. The
// sender (B2C_ACK_FROM_EMAIL) must be a verified sender or domain in the Brevo account.
//
// `send` resolves once Brevo has accepted the message: acceptance, not confirmed delivery.
// Errors are reported in our own wording with Brevo's short reason; never the API key.
const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function brevoError(status, body) {
  const reason = String(body?.message || body?.code || '').replace(/[\r\n]+/g, ' ').slice(0, 160);
  const detail = reason ? `: ${reason}` : '';
  if (status === 401 || status === 403) return new ConnectorError(`Brevo refused the API key (${status}). Check B2C_ACK_API_KEY.`, { retryable: false, status, connector: 'brevo' });
  if (status === 429 || status >= 500) return new ConnectorError(`Brevo could not take the message right now (${status})${detail}.`, { retryable: true, status, connector: 'brevo' });
  return new ConnectorError(`Brevo rejected the message (${status})${detail}.`, { retryable: false, status, connector: 'brevo' });
}

export function createBrevoAckSender(ack, { fetchImpl = globalThis.fetch } = {}) {
  const check = () => validateAckConfig(ack);
  return {
    provider: 'brevo',
    mode: 'live',
    enabled: ack.enabled,
    fromEmail: ack.fromEmail,
    isConfigured: () => check().configured,
    configCheck: check,
    describeServer: () => ({ provider: 'brevo', host: 'api.brevo.com', port: 443, security: 'HTTPS', from: ack.fromEmail || null }),
    async send({ to, replyTo, subject, text, messageId }) {
      const { configured, missing } = check();
      if (!configured) throw new ConnectorError(`The acknowledgement sender is not configured: ${missing.map(name => `${name} is not set`).join('; ')}.`, { retryable: false, connector: 'brevo' });
      if (!EMAIL.test(String(to || ''))) throw new ConnectorError('The recipient address is not valid.', { retryable: false, connector: 'brevo' });
      let response;
      try {
        response = await fetchImpl(BREVO_SEND_URL, {
          method: 'POST',
          headers: { 'api-key': ack.api.key, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: { name: ack.fromName || ack.companyName, email: ack.fromEmail },
            to: [{ email: to }],
            ...(replyTo && EMAIL.test(replyTo) ? { replyTo: { email: replyTo } } : {}),
            subject: String(subject).replace(/[\r\n]+/g, ' '),
            textContent: text,
            // Our Message-ID lets a customer's reply find its ticket or registration.
            headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', ...(messageId ? { 'Message-Id': messageId } : {}) },
          }),
          signal: AbortSignal.timeout(ack.api.timeoutMs || 20000),
        });
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new ConnectorError(timedOut ? 'Brevo did not answer in time.' : 'Could not reach Brevo.', { retryable: true, connector: 'brevo' });
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw brevoError(response.status, body);
      // Brevo reports the Message-ID it used; replies may quote it instead of ours.
      return { providerMessageId: body.messageId || messageId, responseCode: response.status };
    },
  };
}
