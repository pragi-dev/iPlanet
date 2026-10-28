import express from 'express';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REQUEST_CATEGORIES, REQUEST_ISSUE_TYPES } from '../ai/requestExtractor.js';
import { indiaToday } from '../ai/serviceDate.js';
import { isOnSiteRequest, ticketRequestCheck } from '../ticketRequests.js';
import { PRIORITIES } from './emailExtractor.js';
import { buildDraft } from './emailRequestMatching.js';

// B2B service requests received by email. The inbox is checked on a schedule (and on
// demand); Claude prepares a draft from each new message, and an iPlanet Service user
// reviews it here. Only approval creates a ticket.
//
// Mounted at /api/iplanet/email-requests, iPlanet Service only:
//   GET  /                 ?status=pending|approved|rejected
//   GET  /status           inbox and Claude configuration, last check
//   POST /check            check the inbox now
//   GET  /options          ?companyId= requesters and devices to choose from
//   GET  /:id
//   PATCH /:id             edit the draft of a pending request
//   POST /:id/approve      creates the ticket from the draft
//   POST /:id/reject       { reason }

const DRAFT_FIELDS = ['companyId', 'customerId', 'deviceId', 'category', 'issueType', 'description', 'priority', 'location', 'preferredServiceDate', 'deviceCount'];
const ID_FIELDS = ['companyId', 'customerId', 'deviceId'];
const safeExtension = (filename, contentType) => {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'application/pdf': '.pdf' }[contentType] || '';
};

const listItem = request => ({
  id: request._id,
  status: request.status,
  from: request.from,
  subject: request.subject,
  receivedAt: request.receivedAt,
  summary: request.extraction?.summary || null,
  isServiceRequest: request.extraction?.isServiceRequest ?? null,
  needsAttention: Boolean(request.matchNotes?.length || request.extraction?.error),
  company: request.draft?.companyId ? { id: request.draft.companyId._id, name: request.draft.companyId.name } : null,
  device: request.draft?.deviceId ? { id: request.draft.deviceId._id, model: request.draft.deviceId.model, serialNumber: request.draft.deviceId.serialNumber } : null,
  category: request.draft?.category,
  issueType: request.draft?.issueType,
  priority: request.draft?.priority,
  ticket: request.ticketId ? { id: request.ticketId._id, ticketId: request.ticketId.ticketId } : null,
});
const detail = request => ({
  ...listItem(request),
  text: request.text,
  attachments: (request.attachments || []).map(({ filename, contentType, size, path: filePath }) => ({ filename, contentType, size, path: filePath })),
  extraction: request.extraction,
  draft: {
    ...Object.fromEntries(DRAFT_FIELDS.map(field => [field, request.draft?.[field] ?? null])),
    ...Object.fromEntries(ID_FIELDS.map(field => [field, request.draft?.[field]?._id || request.draft?.[field] || null])),
  },
  matchNotes: request.matchNotes || [],
  reviewedAt: request.reviewedAt || null,
  rejectionReason: request.rejectionReason || null,
});
const populated = query => query.populate('draft.companyId', 'name location').populate('draft.deviceId', 'model serialNumber assetId').populate('ticketId', 'ticketId');

// What a reviewer may change on a draft; anything else in the body is ignored.
function draftUpdate(body = {}) {
  const update = {};
  for (const field of DRAFT_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (ID_FIELDS.includes(field)) update[`draft.${field}`] = value && mongoose.isValidObjectId(value) ? value : null;
    else if (field === 'deviceCount') update[`draft.${field}`] = value === '' || value === null ? null : Number(value);
    else update[`draft.${field}`] = typeof value === 'string' ? value.trim().slice(0, field === 'description' ? 4000 : 100) || null : null;
  }
  return update;
}

// Checks a draft the same way a corporate admin's Raise Request is checked.
async function draftError({ models, draft }) {
  const { User, Company, Device } = models;
  if (!draft.companyId || !(await Company.exists({ _id: draft.companyId }))) return 'Choose the organization this request is for.';
  if (!draft.customerId || !(await User.exists({ _id: draft.customerId, role: 'corporate_admin', companyId: draft.companyId }))) return 'Choose who the request is for (a Corporate Self-Care user of the organization).';
  if (!REQUEST_CATEGORIES.includes(draft.category)) return 'Choose the request category.';
  if (!PRIORITIES.includes(draft.priority)) return 'Choose a priority.';
  if (!draft.description?.trim()) return 'Add a description of the issue.';
  if (draft.preferredServiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(draft.preferredServiceDate)) return 'Enter the preferred date as a calendar date.';
  if (!isOnSiteRequest(draft.category)) {
    if (!REQUEST_ISSUE_TYPES.includes(draft.issueType)) return 'Choose the issue type.';
    if (!draft.deviceId || !(await Device.exists({ _id: draft.deviceId, companyId: draft.companyId }))) return 'Choose the organization device this request is for.';
  }
  const check = ticketRequestCheck({ ...draft, deviceId: draft.deviceId ? String(draft.deviceId) : '' }, indiaToday());
  return check.error || null;
}

export function createEmailRequestModule({ models, auth, allowRoles, mailbox, extract, uploadDir, createTicket, onReceived = async () => {}, now = () => new Date(), logger = console }) {
  const { EmailRequest, User, Device } = models;
  const router = express.Router();
  const serviceAuth = [auth, allowRoles('iplanet_service')];
  const state = { running: null, lastCheckedAt: null, lastError: null, lastReceived: 0 };

  async function saveAttachments(attachments = []) {
    const saved = [];
    for (const item of attachments) {
      const name = `email-${crypto.randomBytes(16).toString('hex')}${safeExtension(item.filename, item.contentType)}`;
      await fs.writeFile(path.join(uploadDir, name), item.content);
      saved.push({ filename: String(item.filename).slice(0, 200), contentType: item.contentType, size: item.size, path: `/uploads/${name}` });
    }
    return saved;
  }

  async function storeMessage(message) {
    if (await EmailRequest.exists({ messageId: message.messageId })) return null;
    let extraction = { source: 'none' };
    let details = null;
    if (!extract) extraction.error = 'Claude is not configured (ANTHROPIC_API_KEY), so the details were not read automatically.';
    else {
      try {
        details = await extract({ from: message.from, subject: message.subject, text: message.text, attachmentNames: message.attachments.map(item => item.filename), today: indiaToday(now()) });
        extraction = { source: 'claude', isServiceRequest: details.isServiceRequest, summary: details.summary, serialNumbers: details.serialNumbers, assetIds: details.assetIds, deviceModel: details.deviceModel, contactName: details.contactName, contactPhone: details.contactPhone, preferredDateText: details.preferredDateText, missingDetails: details.missingDetails };
      } catch (error) {
        logger.warn(`[Email requests] Claude could not read a message: ${error?.message || error}`);
        extraction.error = 'Claude could not read this email. Fill in the details from the message.';
      }
    }
    const { draft, matchNotes } = await buildDraft({ models, from: message.from, extraction: details, now: now() });
    const attachments = await saveAttachments(message.attachments);
    try {
      return await EmailRequest.create({ messageId: message.messageId, inReplyTo: message.inReplyTo, from: message.from, subject: message.subject, text: message.text.slice(0, 50000), receivedAt: message.receivedAt, attachments, extraction, draft, matchNotes });
    } catch (error) {
      if (error?.code === 11000) return null; // stored by a parallel check
      throw error;
    }
  }

  // Runs one inbox check; concurrent callers share the check already in progress.
  function checkInbox() {
    if (state.running) return state.running;
    state.running = (async () => {
      if (!mailbox?.isConfigured()) throw Object.assign(new Error('The service-request inbox is not configured. Set B2B_EMAIL_IMAP_HOST, B2B_EMAIL_USER and B2B_EMAIL_PASSWORD in backend/.env.b2b-email.'), { status: 503 });
      const messages = await mailbox.fetchUnread({ limit: 10 });
      const stored = [];
      const handled = [];
      for (const message of messages) {
        try {
          const request = await storeMessage(message);
          if (request) stored.push(request);
          handled.push(message.uid);
        } catch (error) {
          // Left unread so the next check tries it again.
          logger.error(`[Email requests] Could not store a message: ${error?.message || error}`);
        }
      }
      await mailbox.markRead(handled);
      for (const request of stored) await onReceived(request).catch(error => logger.warn(`[Email requests] Could not notify reviewers: ${error.message}`));
      state.lastReceived = stored.length;
      state.lastError = null;
      return { received: stored.length, checked: messages.length };
    })().catch(error => {
      state.lastError = error.status === 503 ? error.message : 'The inbox could not be checked. Verify the mailbox settings and password.';
      if (error.status !== 503) logger.error(`[Email requests] Inbox check failed: ${error?.message || error}`);
      throw error;
    }).finally(() => { state.lastCheckedAt = now(); state.running = null; });
    return state.running;
  }

  router.get('/status', ...serviceAuth, async (_, res) => {
    res.json({ inbox: mailbox?.address || null, inboxConfigured: Boolean(mailbox?.isConfigured()), claudeConfigured: Boolean(extract), checking: Boolean(state.running), lastCheckedAt: state.lastCheckedAt, lastError: state.lastError, pending: await EmailRequest.countDocuments({ status: 'pending' }) });
  });

  router.post('/check', ...serviceAuth, async (_, res) => {
    try { res.json(await checkInbox()); }
    catch (error) { res.status(error.status || 502).json({ message: state.lastError || 'The inbox could not be checked.' }); }
  });

  router.get('/options', ...serviceAuth, async (req, res) => {
    const companyId = mongoose.isValidObjectId(req.query.companyId) ? req.query.companyId : null;
    if (!companyId) return res.json({ customers: [], devices: [] });
    const [customers, devices] = await Promise.all([
      User.find({ role: 'corporate_admin', companyId }).select('name email phone').sort({ name: 1 }).lean(),
      Device.find({ companyId }).select('model serialNumber assetId deviceType location employeeName').sort({ assetId: 1 }).lean(),
    ]);
    res.json({ customers: customers.map(user => ({ id: user._id, name: user.name, email: user.email })), devices: devices.map(device => ({ id: device._id, model: device.model, serialNumber: device.serialNumber, assetId: device.assetId, location: device.location })) });
  });

  router.get('/', ...serviceAuth, async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const requests = await populated(EmailRequest.find({ status }).sort({ receivedAt: status === 'pending' ? 1 : -1 }).limit(200)).lean();
    res.json(requests.map(listItem));
  });

  router.get('/:id', ...serviceAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Email request not found' });
    const request = await populated(EmailRequest.findById(req.params.id)).lean();
    if (!request) return res.status(404).json({ message: 'Email request not found' });
    res.json(detail(request));
  });

  router.patch('/:id', ...serviceAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Email request not found' });
    const updated = await populated(EmailRequest.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: draftUpdate(req.body) }, { new: true })).lean();
    if (updated) return res.json(detail(updated));
    const existing = await EmailRequest.findById(req.params.id).lean();
    return existing ? res.status(409).json({ message: `This request has already been ${existing.status}.` }) : res.status(404).json({ message: 'Email request not found' });
  });

  router.post('/:id/approve', ...serviceAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Email request not found' });
    // Saves any last edits sent with the approval first, so the ticket matches the form.
    const edits = draftUpdate(req.body);
    const request = Object.keys(edits).length
      ? await EmailRequest.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: edits }, { new: true })
      : await EmailRequest.findById(req.params.id);
    if (!request) {
      const existing = await EmailRequest.findById(req.params.id).lean();
      return existing ? res.status(409).json({ message: `This request has already been ${existing.status}.` }) : res.status(404).json({ message: 'Email request not found' });
    }
    if (request.status !== 'pending') return res.status(409).json({ message: `This request has already been ${request.status}.` });
    const { draft } = request.toObject();
    const error = await draftError({ models, draft });
    if (error) return res.status(400).json({ message: error });
    // Claimed before the ticket is created, so a double click can't create two tickets.
    const claimed = await EmailRequest.findOneAndUpdate({ _id: request._id, status: 'pending' }, { $set: { status: 'approved', reviewedBy: req.user.id, reviewedAt: now() } }, { new: true });
    if (!claimed) return res.status(409).json({ message: 'This request has already been reviewed.' });
    let ticket;
    try {
      ticket = await createTicket({ draft, emailRequest: claimed, reviewer: req.user });
    } catch (creationError) {
      await EmailRequest.updateOne({ _id: request._id }, { $set: { status: 'pending' }, $unset: { reviewedBy: 1, reviewedAt: 1 } });
      throw creationError;
    }
    const approved = await populated(EmailRequest.findByIdAndUpdate(request._id, { $set: { ticketId: ticket._id } }, { new: true })).lean();
    res.json(detail(approved));
  });

  router.post('/:id/reject', ...serviceAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Email request not found' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    const rejected = await populated(EmailRequest.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'rejected', reviewedBy: req.user.id, reviewedAt: now(), rejectionReason: reason || null } }, { new: true })).lean();
    if (rejected) return res.json(detail(rejected));
    const existing = await EmailRequest.findById(req.params.id).lean();
    return existing ? res.status(409).json({ message: `This request has already been ${existing.status}.` }) : res.status(404).json({ message: 'Email request not found' });
  });

  const scheduler = {
    timer: null,
    start(minutes) {
      if (!mailbox?.isConfigured()) { logger.info('[Email requests] Inbox not configured; scheduled checks are off.'); return; }
      const every = Math.max(1, Number(minutes) || 2);
      logger.info(`[Email requests] Checking ${mailbox.address} every ${every} minute${every === 1 ? '' : 's'}.`);
      const run = () => checkInbox().catch(() => {});
      run();
      this.timer = setInterval(run, every * 60000);
      this.timer.unref?.();
    },
    stop() { clearInterval(this.timer); this.timer = null; },
  };

  return { router, scheduler, checkInbox };
}
