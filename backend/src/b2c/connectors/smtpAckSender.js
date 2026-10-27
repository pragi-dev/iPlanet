import nodemailer from 'nodemailer';
import { validateAckConfig } from '../b2cConfig.js';
import { ConnectorError } from './connectorErrors.js';

// Sends customer acknowledgements from the separate company address (e.g.
// noreply@aavoraa.com) over authenticated SMTP with TLS. It only sends: the IMAP
// adapter keeps reading the inbox with its own, separate account.
//
// `send` resolves once the SMTP server has accepted the message (a 2xx reply).
// That is acceptance by the provider, not confirmed delivery to the mailbox.
// Errors are reported in our own wording, never the server's reply or credentials.
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const NETWORK = /^(ETIMEDOUT|ETIMEOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ESOCKET|ECONNECTION)$/;

function smtpError(error) {
  const code = String(error?.code || '');
  const status = Number(error?.responseCode) || null;
  if (code === 'EAUTH') return new ConnectorError('SMTP login failed. Check B2C_ACK_SMTP_USER and B2C_ACK_SMTP_PASS.', { retryable: false, connector: 'smtp' });
  if (code === 'ETLS' || /certificate|ssl|tls/i.test(error?.message || '')) return new ConnectorError('SMTP secure connection failed. Check B2C_ACK_SMTP_PORT and B2C_ACK_SMTP_SECURE.', { retryable: false, connector: 'smtp' });
  if (code === 'EENVELOPE' || (status >= 500 && status < 600)) return new ConnectorError(`The SMTP server refused the message${status ? ` (${status})` : ''}.`, { retryable: false, status, connector: 'smtp' });
  if (status >= 400 && status < 500) return new ConnectorError(`The SMTP server deferred the message (${status}).`, { retryable: true, status, connector: 'smtp' });
  if (NETWORK.test(code) || /timeout|closed|connect/i.test(error?.message || '')) return new ConnectorError(`Could not reach the SMTP server${code ? ` (${code})` : ''}.`, { retryable: true, connector: 'smtp' });
  return new ConnectorError(`SMTP sending failed${code ? ` (${code})` : ''}.`, { retryable: true, connector: 'smtp' });
}

export function createSmtpAckSender(ack, { createTransport = nodemailer.createTransport } = {}) {
  const check = () => validateAckConfig(ack);
  let transport = null;
  const transporter = () => {
    transport ||= createTransport({
      host: ack.smtp.host,
      port: ack.smtp.port,
      secure: ack.smtp.secure,
      // Without implicit TLS the connection must upgrade with STARTTLS, or nothing is sent.
      requireTLS: !ack.smtp.secure,
      auth: { user: ack.smtp.user, pass: ack.smtp.pass },
      tls: { minVersion: 'TLSv1.2', servername: ack.smtp.host },
      connectionTimeout: ack.smtp.timeoutMs,
      greetingTimeout: ack.smtp.timeoutMs,
      socketTimeout: ack.smtp.timeoutMs,
    });
    return transport;
  };
  return {
    provider: 'smtp',
    mode: 'live',
    enabled: ack.enabled,
    fromEmail: ack.fromEmail,
    isConfigured: () => check().configured,
    configCheck: check,
    describeServer: () => ({ host: ack.smtp.host || null, port: ack.smtp.port, security: ack.smtp.secure ? 'SSL/TLS' : 'STARTTLS', from: ack.fromEmail || null }),
    // `to` and `replyTo` are validated addresses; subject and text are plain text
    // without line breaks in the subject (see templates.js), so no header can be added.
    async send({ to, replyTo, subject, text, messageId }) {
      const { configured, missing } = check();
      if (!configured) throw new ConnectorError(`The acknowledgement sender is not configured: ${missing.map(name => `${name} is not set`).join('; ')}.`, { retryable: false, connector: 'smtp' });
      if (!EMAIL.test(String(to || ''))) throw new ConnectorError('The recipient address is not valid.', { retryable: false, connector: 'smtp' });
      try {
        const info = await transporter().sendMail({
          from: { name: ack.fromName || ack.companyName, address: ack.fromEmail },
          to,
          ...(replyTo && EMAIL.test(replyTo) ? { replyTo } : {}),
          subject: String(subject).replace(/[\r\n]+/g, ' '),
          text,
          messageId,
          headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
        });
        const responseCode = Number.parseInt(String(info?.response || '').slice(0, 3), 10);
        return { providerMessageId: info?.messageId || messageId, responseCode: Number.isInteger(responseCode) ? responseCode : null };
      } catch (error) {
        throw smtpError(error);
      }
    },
  };
}
