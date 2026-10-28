import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// The B2B service-request inbox, read over IMAP. Its settings (B2B_EMAIL_*) live in their
// own file, backend/.env.b2b-email, kept apart from backend/.env and the B2C settings, and
// are read only here: they are never added to process.env. Where there is no file (for
// example on Render), the same names are read from the environment.
//   fetchUnread({ limit }) -> [{ uid, messageId, inReplyTo, from, subject, text, receivedAt, attachments }]
//   markRead(uids)            called once the messages are safely stored
// Each call opens its own short connection, so a slow Claude call between the two never
// holds an idle IMAP session open.

export const EMAIL_SETTINGS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env.b2b-email');

function emailSettings(file = EMAIL_SETTINGS_FILE) {
  try { return dotenv.parse(fs.readFileSync(file)); } catch { return process.env; }
}

export function emailInboxConfig(environment = emailSettings()) {
  return {
    host: environment.B2B_EMAIL_IMAP_HOST?.trim() || '',
    port: Number(environment.B2B_EMAIL_IMAP_PORT) || 993,
    secure: environment.B2B_EMAIL_IMAP_SECURE !== 'false',
    user: environment.B2B_EMAIL_USER?.trim() || '',
    pass: environment.B2B_EMAIL_PASSWORD || '',
    mailbox: environment.B2B_EMAIL_MAILBOX?.trim() || 'INBOX',
    pollMinutes: Number(environment.B2B_EMAIL_POLL_MINUTES) || 2,
    // Ticket updates are sent from the same mailbox, so they arrive in the customer's thread.
    smtp: {
      host: environment.B2B_EMAIL_SMTP_HOST?.trim() || '',
      port: Number(environment.B2B_EMAIL_SMTP_PORT) || 465,
      secure: environment.B2B_EMAIL_SMTP_SECURE !== 'false',
      fromName: environment.B2B_EMAIL_FROM_NAME?.trim() || 'iPlanet Service',
    },
  };
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

export function createImapMailbox(config = emailInboxConfig()) {
  const isConfigured = () => Boolean(config.host && config.user && config.pass);

  async function withMailbox(work) {
    const client = new ImapFlow({ host: config.host, port: config.port, secure: config.secure, auth: { user: config.user, pass: config.pass }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    try { return await work(client); }
    finally { lock.release(); await client.logout().catch(() => {}); }
  }

  return {
    address: config.user,
    isConfigured,
    async fetchUnread({ limit = 10 } = {}) {
      return withMailbox(async client => {
        const uids = (await client.search({ seen: false }, { uid: true })) || [];
        const batch = uids.slice(0, limit);
        if (!batch.length) return [];
        // fetch() must finish before other commands run on the connection, so the raw
        // messages are collected first and parsed afterwards.
        const raw = [];
        for await (const message of client.fetch(batch.join(','), { uid: true, source: true }, { uid: true })) raw.push({ uid: message.uid, source: message.source });
        const messages = [];
        for (const { uid, source } of raw) {
          const parsed = await simpleParser(source);
          const sender = parsed.from?.value?.[0] || {};
          messages.push({
            uid,
            // A message without a Message-ID still needs a stable key so it is stored once.
            messageId: parsed.messageId || `imap:${config.user}:${config.mailbox}:${uid}`,
            inReplyTo: parsed.inReplyTo || null,
            from: { address: String(sender.address || '').toLowerCase(), name: sender.name || '' },
            subject: parsed.subject || '',
            text: (parsed.text || '').trim(),
            receivedAt: parsed.date || new Date(),
            attachments: (parsed.attachments || [])
              .filter(item => item.contentDisposition !== 'inline' || /^image\//.test(item.contentType))
              .filter(item => item.size <= MAX_ATTACHMENT_BYTES)
              .slice(0, MAX_ATTACHMENTS)
              .map(item => ({ filename: item.filename || 'attachment', contentType: item.contentType, size: item.size, content: item.content })),
          });
        }
        return messages;
      });
    },
    async markRead(uids) {
      if (!uids.length) return;
      await withMailbox(client => client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true }));
    },
  };
}
