import nodemailer from 'nodemailer';

// Acknowledgement emails for tickets raised by email: one when the ticket is opened, with a
// link to track it, and one when it is closed. Other status changes are followed on the
// tracking page, not mailed. Each message goes to the address the request came from, as a
// reply in that email's thread, sent from the B2B request mailbox. Tickets raised in the
// portal have no emailSource and are never mailed. Sending runs after the ticket update is
// saved and is retried on a schedule, so a mail server problem never blocks the update.
//   queueUpdate({ ticket, entry, device, created })   entry is the TicketTimeline record
//   processQueue()                                     sends what is due

const MAX_ATTEMPTS = 5;
const LOCK_MS = 2 * 60000;
const backoffMs = attempts => Math.min(60, 2 ** attempts) * 60000;
const istTime = date => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(date);
// Only a real Message-ID can thread a reply; stored fallback keys ("imap:...") can't.
const threadId = messageId => (/^<[^<>\s]+>$/.test(messageId || '') ? messageId : null);

// Returns send({ to, subject, text, inReplyTo }) -> { messageId }, or null when SMTP isn't configured.
export function createSmtpSender(config) {
  if (!config?.smtp?.host || !config.user || !config.pass) return null;
  const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: { user: config.user, pass: config.pass } });
  return async ({ to, subject, text, inReplyTo }) => {
    const info = await transport.sendMail({ from: { name: config.smtp.fromName, address: config.user }, to, subject, text, ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}) });
    return { messageId: info.messageId };
  };
}

export const isAcknowledged = ({ entry, created }) => created || entry?.status === 'Closed';

// trackingUrl is the public page for this ticket, included in the opening email.
export function composeTicketEmail({ ticket, entry, device, created, trackingUrl }) {
  const source = ticket.emailSource;
  const original = String(source.subject || '').trim();
  const subject = original ? (/^re:/i.test(original) ? original : `Re: ${original}`) : `Your service request ${ticket.ticketId}`;
  const request = [ticket.category, ticket.issueType].filter(Boolean).join(' – ');
  const details = [
    `Ticket: ${ticket.ticketId}`,
    request ? `Request: ${request}` : null,
    device?.model ? `Device: ${device.model}${device.serialNumber ? ` (${device.serialNumber})` : ''}` : null,
    ticket.deviceCount ? `Devices: ${ticket.deviceCount}` : null,
    ticket.priority ? `Priority: ${ticket.priority}` : null,
    ticket.preferredServiceDate ? `Preferred date: ${new Date(ticket.preferredServiceDate).toISOString().slice(0, 10)}` : null,
  ].filter(Boolean);
  const lines = [`Dear ${source.name || 'Customer'},`, ''];
  if (created) {
    lines.push(`Thank you for your email. We have logged your request as ticket ${ticket.ticketId}.`, '', ...details, `Status: ${entry.status}`, '');
    if (trackingUrl) lines.push('Track the progress of your request at any time:', trackingUrl, '');
    lines.push(`We will email you again when the ticket is closed. Please quote ${ticket.ticketId} if you write to us about it.`);
  } else {
    lines.push(`Your service request ${ticket.ticketId} has been closed.`, '', `Closing note: ${entry.message}`, `Closed: ${istTime(entry.timestamp || entry.createdAt || new Date())} IST`, '', ...details, '', `If the issue is not resolved, reply to this email quoting ${ticket.ticketId}.`);
  }
  lines.push('', 'Regards,', 'iPlanet Service', '', 'This is an automated message.');
  return { subject, text: lines.join('\n') };
}

// trackingUrl(token) -> the public tracking page address.
export function createTicketEmailUpdates({ models, send, fromAddress, trackingUrl = () => null, now = () => new Date(), logger = console }) {
  const { TicketEmail } = models;
  let processing = null;

  async function queueUpdate({ ticket, entry, device, created = false }) {
    const to = ticket?.emailSource?.address;
    if (!send || !to || !entry?._id || !isAcknowledged({ entry, created }) || to.toLowerCase() === String(fromAddress || '').toLowerCase()) return null;
    try {
      const token = ticket.emailSource.trackingToken;
      const { subject, text } = composeTicketEmail({ ticket, entry, device, created, trackingUrl: created && token ? trackingUrl(token) : null });
      const email = await TicketEmail.create({ dedupeKey: `timeline:${entry._id}`, ticketId: ticket._id, to, subject, text, inReplyTo: threadId(ticket.emailSource.messageId), nextAttemptAt: now() });
      processQueue().catch(() => {});
      return email;
    } catch (error) {
      if (error?.code === 11000) return null; // already queued for this entry
      logger.error(`[Ticket emails] Could not queue an update for ${ticket.ticketId}: ${error?.message || error}`);
      return null;
    }
  }

  async function claimNext() {
    const at = now();
    return TicketEmail.findOneAndUpdate(
      { status: 'queued', nextAttemptAt: { $lte: at }, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: at } }] },
      { $set: { lockedUntil: new Date(at.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, new: true },
    );
  }

  // Concurrent callers share the run in progress.
  function processQueue({ limit = 20 } = {}) {
    if (!send) return Promise.resolve([]);
    if (processing) return processing;
    processing = (async () => {
      const results = [];
      for (let count = 0; count < limit; count += 1) {
        const email = await claimNext();
        if (!email) break;
        try {
          const { messageId } = await send({ to: email.to, subject: email.subject, text: email.text, inReplyTo: email.inReplyTo });
          Object.assign(email, { status: 'sent', sentAt: now(), messageId, lockedUntil: null, lastError: null, nextAttemptAt: null });
        } catch (error) {
          const failed = email.attempts >= MAX_ATTEMPTS;
          Object.assign(email, { status: failed ? 'failed' : 'queued', lockedUntil: null, lastError: String(error?.message || error).slice(0, 300), nextAttemptAt: failed ? null : new Date(now().getTime() + backoffMs(email.attempts)) });
          logger.warn(`[Ticket emails] Sending to ${email.to} failed (attempt ${email.attempts}): ${email.lastError}`);
        }
        await email.save();
        results.push({ id: email._id, status: email.status });
      }
      return results;
    })().finally(() => { processing = null; });
    return processing;
  }

  const scheduler = {
    timer: null,
    start(minutes) {
      if (!send) { logger.info('[Ticket emails] SMTP not configured (B2B_EMAIL_SMTP_HOST); acknowledgement emails are off.'); return; }
      logger.info(`[Ticket emails] Sending opening and closing acknowledgements from ${fromAddress}.`);
      const run = () => processQueue().catch(error => logger.error(`[Ticket emails] ${error?.message || error}`));
      run();
      this.timer = setInterval(run, Math.max(1, Number(minutes) || 2) * 60000);
      this.timer.unref?.();
    },
    stop() { clearInterval(this.timer); this.timer = null; },
  };

  return { queueUpdate, processQueue, scheduler };
}
