import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ConnectorError } from './connectorErrors.js';
import { validateImapConfig } from '../b2cConfig.js';

// Incoming mail from an IMAP mailbox (MilesWeb: mail.aavoraa.com:993, SSL/TLS).
// It implements the reading half of the email connector contract:
//
//   fetchNew({ inbox, limit }) -> [RawEmail]      unread messages, oldest first
//   markProcessed({ inbox, providerMessageId })    sets \Seen once the message is stored
//   verify() -> { ok: true }                        login and mailbox check
//
// Messages are downloaded with BODY.PEEK, so they stay unread until the ticket
// pipeline has stored them; a crash before then means they are fetched again
// and de-duplicated. IMAP only reads: it has no send(), so customer email for
// an IMAP inbox is recorded as not sent. The provider message id is
// "<UIDVALIDITY>:<UID>", which stays stable as long as the mailbox is not recreated.
const AUTO_HEADERS = /^(auto-submitted|precedence|x-autoreply|x-autorespond|x-auto-response-suppress)$/i;

export function classifyImapError(error) {
  if (error instanceof ConnectorError) return error;
  const code = String(error?.code || '');
  if (error?.authenticationFailed) return new ConnectorError('IMAP login failed. Check the mailbox user name and password.', { retryable: false, connector: 'imap' });
  if (error?.mailboxMissing) return new ConnectorError('The IMAP mailbox folder does not exist. Check IMAP_MAILBOX.', { retryable: false, connector: 'imap' });
  if (/certificate|ssl|tls/i.test(error?.message || '') && !/timeout/i.test(error?.message || '')) return new ConnectorError('IMAP secure connection failed. Check IMAP_PORT and IMAP_SECURE.', { retryable: false, connector: 'imap' });
  if (/^(ETIMEDOUT|ETIMEOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|NoConnection|ClosedAfterConnectTLS|ClosedAfterConnectText|EConnectionClosed)$/.test(code) || /timeout|closed|connect/i.test(error?.message || '')) return new ConnectorError(`Could not reach the IMAP server${code ? ` (${code})` : ''}.`, { retryable: true, connector: 'imap' });
  return new ConnectorError(`IMAP request failed${code ? ` (${code})` : ''}.`, { retryable: true, connector: 'imap' });
}

const addresses = field => (Array.isArray(field) ? field : field ? [field] : []).flatMap(item => item.value || []).map(item => item.address).filter(Boolean);

// Parsed MIME message -> the connector's RawEmail shape.
export async function rawEmailFromSource(source, { providerMessageId, receivedAt, parse = simpleParser } = {}) {
  const parsed = await parse(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const sender = parsed.from?.value?.[0] || {};
  return {
    providerMessageId,
    internetMessageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || null,
    from: { address: sender.address, name: sender.name },
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: parsed.subject || '',
    text: parsed.text || '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    receivedAt: receivedAt || parsed.date || new Date(),
    headers: Object.fromEntries((parsed.headerLines || []).filter(item => AUTO_HEADERS.test(item.key || '')).map(item => [item.key.toLowerCase(), item.line.slice(item.line.indexOf(':') + 1).trim()])),
    // Inline images (signatures, logos) are part of the body, not attachments.
    attachments: (parsed.attachments || []).filter(item => !item.related && !(item.contentDisposition === 'inline' && item.cid)).map(item => ({ filename: item.filename || 'attachment', contentType: item.contentType, size: item.size, content: item.content })),
  };
}

export function createImapEmailAdapter(imap = {}, { createClient = options => new ImapFlow(options), parse = simpleParser, idleCloseMs = 10_000 } = {}) {
  const check = validateImapConfig(imap);
  let client = null;
  let closeTimer = null;
  let queue = Promise.resolve();

  async function drop() {
    const current = client;
    client = null;
    if (!current) return;
    try { await current.logout(); } catch { current.close?.(); }
  }

  async function open() {
    if (client?.usable) return client;
    client = null;
    const next = createClient({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      // On a non-TLS port, refuse to log in without STARTTLS.
      doSTARTTLS: imap.secure ? undefined : true,
      auth: { user: imap.user, pass: imap.pass },
      tls: { minVersion: 'TLSv1.2', servername: imap.host },
      connectionTimeout: imap.connectionTimeoutMs,
      greetingTimeout: imap.connectionTimeoutMs,
      socketTimeout: imap.socketTimeoutMs,
      disableAutoIdle: true,
      logger: false,
    });
    // Connection errors reach the awaiting call; this stops an unhandled 'error' event.
    next.on?.('error', () => {});
    try {
      await next.connect();
      await next.mailboxOpen(imap.mailbox);
    } catch (error) {
      try { await next.logout(); } catch { next.close?.(); }
      throw classifyImapError(error);
    }
    client = next;
    return client;
  }

  // One operation at a time on a shared connection, closed after a short idle period,
  // so a poll and the markProcessed calls that follow it use a single login.
  function session(task) {
    const run = queue.then(async () => {
      clearTimeout(closeTimer);
      if (!check.configured) throw new ConnectorError(`IMAP is not configured: ${check.missing.map(name => `${name} is not set`).join('; ')}.`, { retryable: false, connector: 'imap' });
      try {
        return await task(await open());
      } catch (error) {
        await drop();
        throw classifyImapError(error);
      } finally {
        closeTimer = setTimeout(() => { queue = queue.then(drop); }, idleCloseMs);
        closeTimer.unref?.();
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  // The credentials open one mailbox; an inbox configured with another address
  // would silently read the wrong mail.
  function assertInbox(inbox) {
    const user = imap.user.toLowerCase();
    if (user.includes('@') && inbox?.address && inbox.address.toLowerCase() !== user) {
      throw new ConnectorError(`This inbox's address (${inbox.address}) is not the IMAP mailbox the server logs into. Use the same address, or set IMAP_USER.`, { retryable: false, connector: 'imap' });
    }
  }

  return {
    provider: 'imap',
    mode: 'live',
    isConfigured: () => check.configured,
    configCheck: () => ({ ...check, missing: [...check.missing] }),
    describeServer: () => ({ host: imap.host || null, port: imap.port, secure: imap.secure, mailbox: imap.mailbox, user: imap.user || null }),
    async verify() {
      await session(async () => {});
      return { ok: true };
    },
    async fetchNew({ inbox, limit = 25 }) {
      assertInbox(inbox);
      return session(async connection => {
        const uidValidity = String(connection.mailbox?.uidValidity ?? '0');
        const uids = ((await connection.search({ seen: false }, { uid: true })) || []).map(Number).sort((a, b) => a - b).slice(0, Math.min(limit, 50));
        const messages = [];
        for (const uid of uids) {
          const providerMessageId = `${uidValidity}:${uid}`;
          const meta = await connection.fetchOne(String(uid), { uid: true, size: true, internalDate: true, envelope: true }, { uid: true });
          if (!meta) continue;
          if (meta.size > imap.maxMessageBytes) {
            // Too large to download: a ticket is still created from the headers.
            const envelope = meta.envelope || {};
            const sender = envelope.from?.[0] || {};
            messages.push({
              providerMessageId, internetMessageId: envelope.messageId, inReplyTo: envelope.inReplyTo, references: null,
              from: { address: sender.address, name: sender.name }, to: (envelope.to || []).map(item => item.address), cc: (envelope.cc || []).map(item => item.address),
              subject: envelope.subject || '', text: `[This email is ${Math.round(meta.size / 1048576)} MB, over the import limit. Open it in the mailbox to read it.]`, html: '',
              receivedAt: meta.internalDate || envelope.date, headers: {}, attachments: [],
            });
            continue;
          }
          const full = await connection.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
          if (!full?.source) continue;
          messages.push(await rawEmailFromSource(full.source, { providerMessageId, receivedAt: meta.internalDate, parse }));
        }
        return messages;
      });
    },
    async markProcessed({ inbox, providerMessageId }) {
      assertInbox(inbox);
      const [uidValidity, uid] = String(providerMessageId).split(':');
      if (!/^\d+$/.test(uid || '')) return;
      await session(async connection => {
        // A recreated mailbox renumbers its messages; those are re-fetched and de-duplicated by Message-ID.
        if (String(connection.mailbox?.uidValidity ?? '0') !== uidValidity) return;
        await connection.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      });
    },
  };
}
