import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { B2C_ADMIN, B2C_ROLES, CATEGORIES, IDENTIFIER_TYPES, STANDARD_PRIORITY, UNCLASSIFIED, defaultSettings } from './b2cDefaults.js';
import { normaliseInboundEmail, ticketReferenceIn } from './emailContent.js';
import { extractIdentifiers } from './identifiers.js';
import { classifyEscalation } from './classifier.js';
import { storeAttachments } from './attachments.js';
import { renderTemplate, templateVars } from './templates.js';
import { redactDetails, safeErrorMessage } from './redact.js';
import { validateSettingsUpdate } from './settingsValidation.js';
import { computeSlaEscalation, slaTargets } from '../slaEscalation.js';
import {
  ACTIONS, ACTIVE_STATUSES, STATUS, allowedActions, canPerform, canView, defaultPath, effectivePath, eligibleForLevel, enabledLevels, isAdmin, levelLabel,
  nextLevel, statusForAssignment, validatorLevelFor, visibilityFilter,
} from './workflow.js';

// The B2C escalation engine: email ingestion, idempotent ticket creation, CRM
// enrichment, triage, workflow routing, customer email and reporting. Routes
// only authenticate and translate HTTP; every rule is applied here.
export class B2CError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const MINUTE = 60_000;
const BACKOFF_MINUTES = [1, 5, 15, 30, 60];
const backoffMs = attempt => (BACKOFF_MINUTES[Math.max(0, attempt - 1)] ?? 60) * MINUTE;
const LOCK_MS = 5 * MINUTE;
const AGE_BUCKETS = [['Under 1 day', 1], ['1–3 days', 3], ['3–7 days', 7], ['7–14 days', 14], ['Over 14 days', Infinity]];
const SORTABLE = ['createdAt', 'updatedAt', 'lastActivityAt', 'reference', 'status', 'category', 'region'];
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idString = value => (value === undefined || value === null ? null : String(value?._id || value));
const person = user => ({ userId: user.id || user._id, name: user.name, email: user.email });
const SYSTEM = { userId: null, name: 'System', role: 'system' };

// escalationRules returns the active B2B EscalationRule records; B2C escalates by the same rules.
export function createB2CService({ models, User, notifyUsers = async () => {}, escalationRules = async () => [], emailConnectors, crmConnector, attachmentStore, config, logger = console, now = () => new Date() }) {
  const { B2CSettings, B2CInboundEmail, B2CEscalation, B2CAuditEvent, B2COutboundEmail, B2CIntegrationStatus, B2CCounter } = models;
  const scheduler = { running: false, lastRunAt: null, lastResult: null, lastError: null };

  // ---- Settings ----------------------------------------------------------------
  async function getSettings() {
    let settings = await B2CSettings.findOne({ key: 'default' }).lean();
    if (settings) return settings;
    try { await B2CSettings.create(defaultSettings(config)); } catch (error) { if (error?.code !== 11000) throw error; }
    settings = await B2CSettings.findOne({ key: 'default' }).lean();
    return settings;
  }

  async function updateSettings(input, user) {
    const current = await getSettings();
    const update = validateSettingsUpdate(input, current, user);
    if (!Object.keys(update).length) throw new B2CError('No settings to update.');
    await B2CSettings.updateOne({ key: 'default' }, { $set: { ...update, updatedBy: user.name || user.email } });
    await auditGeneral('settings_updated', user, { details: { sections: Object.keys(update) }, link: '/b2c/settings' });
    return getSettings();
  }

  // ---- Shared helpers ------------------------------------------------------------
  async function nextReference() {
    const year = now().getFullYear();
    const counter = await B2CCounter.findOneAndUpdate({ key: `reference-${year}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
    return `${config.referencePrefix}-${year}-${String(counter.seq).padStart(6, '0')}`;
  }

  // `alerted` lists the users already sent a specific notification for this event.
  async function audit(ticket, action, { actor = SYSTEM, fromStatus, toStatus, note, details, alerted } = {}) {
    const resolvedActor = actor === SYSTEM ? SYSTEM : { userId: actor.id || actor.userId, name: actor.name, role: actor.b2cRole || actor.role };
    const event = await B2CAuditEvent.create({ ticketId: ticket._id, reference: ticket.reference, action, actor: resolvedActor, fromStatus, toStatus, note: note ? String(note).slice(0, 5000) : undefined, details: redactDetails(details), at: now() });
    await notifyLog(event, ticket, { alerted });
    return event;
  }
  // Log entries that belong to no single escalation (settings, test email, reprocessing).
  async function auditGeneral(action, user, { ticketId = null, details, link }) {
    const event = await B2CAuditEvent.create({ ticketId, action, actor: { userId: user.id, name: user.name, role: user.b2cRole }, details, at: now() });
    await notifyLog(event, null, { link });
  }
  async function auditOnce(ticket, action, options) {
    if (await B2CAuditEvent.exists({ ticketId: ticket._id, action })) return null;
    return audit(ticket, action, options);
  }

  async function recordIntegration(key, { kind, label, provider, mode, ok, error, details }) {
    const at = now();
    const set = { kind, label, provider, mode, lastRunAt: at, ...(details ? { details } : {}) };
    const update = ok
      ? { $set: { ...set, lastSuccessAt: at, consecutiveFailures: 0 } }
      : { $set: { ...set, lastErrorAt: at, lastError: safeErrorMessage(error) }, $inc: { consecutiveFailures: 1 } };
    await B2CIntegrationStatus.updateOne({ key }, update, { upsert: true });
  }

  const route = ticket => `/b2c/tickets/${ticket._id}`;
  const userKey = user => idString(user?._id || user?.userId || user?.id);
  // Returns the ids of the users notified.
  async function notify(users, ticket, title, message, link = route(ticket)) {
    const ids = [...new Set(users.filter(Boolean).map(userKey).filter(Boolean))];
    if (!ids.length) return [];
    // Notification text names the reference only, never customer details.
    try {
      const recipients = await User.find({ _id: { $in: ids } }).select('_id role').lean();
      await notifyUsers({ users: recipients, type: 'B2C_ESCALATION', title, message, action: { type: 'B2C_ESCALATION', route: link } });
      return ids;
    } catch (error) {
      logger.warn(`[B2C] Notification failed for ${ticket?.reference || link}: ${safeErrorMessage(error)}`);
      return [];
    }
  }

  // Every audit-log entry is also posted to the B2C notification feed of the admins and
  // everyone involved in the escalation, except the person who did it and anyone already
  // sent a specific notification for it. Notes are left out: they can quote the customer.
  const LOG_TITLES = {
    created_from_email: 'Created from email', crm_lookup: 'CRM lookup', crm_lookup_failed: 'CRM lookup failed', crm_not_configured: 'CRM not connected',
    queued_for_triage: 'Queued for triage', triage_completed: 'Triage completed', routed: 'Routed to workflow', acknowledgement_queued: 'Acknowledgement queued',
    email_sent: 'Email sent', email_send_failed: 'Email send failed', customer_replied: 'Customer replied', sla_escalation: 'SLA escalation', claim: 'Took ownership', assign: 'Engineer assigned', accept: 'Engineer accepted',
    start: 'Work started', reroute: 'Rerouted', set_path: 'Workflow path changed', request_clarification: 'Clarification requested',
    propose_resolution: 'Repair completion submitted', approve_resolution: 'Resolution approved', reject_resolution: 'Resolution returned for rework',
    close: 'Closed', close_unresolved: 'Closed without resolution', reopen: 'Reopened', add_note: 'Internal note added', attachment_downloaded: 'Attachment downloaded',
    settings_updated: 'B2C settings updated', test_email_injected: 'Test email injected', inbound_reprocess_requested: 'Email reprocessing requested',
  };
  const logTitle = action => LOG_TITLES[action] || action.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());
  async function notifyLog(event, ticket, { alerted = [], link } = {}) {
    try {
      const skip = new Set([idString(event.actor?.userId), ...alerted].filter(Boolean));
      const involved = ticket ? [ticket.workflow?.assignee, ...(ticket.participants || []).map(userId => ({ userId }))] : [];
      const recipients = [...involved, ...await admins()].filter(user => user && !skip.has(userKey(user)));
      const title = logTitle(event.action);
      const status = event.toStatus ? ` Status: ${event.fromStatus && event.fromStatus !== event.toStatus ? `${event.fromStatus} → ` : ''}${event.toStatus}.` : '';
      await notify(recipients, ticket, title, `${ticket?.reference || 'B2C'}: ${title} by ${event.actor?.name || 'System'}.${status}`, link || (ticket ? route(ticket) : '/b2c'));
    } catch (error) { logger.warn(`[B2C] Log notification failed for ${event.action}: ${safeErrorMessage(error)}`); }
  }
  const STAFF_ROLES = ['b2c_staff', 'iplanet_service'];
  const staffQuery = filter => User.find({ role: { $in: STAFF_ROLES }, ...filter }).select('_id name email role b2cRole b2cRegions').lean();
  const admins = () => staffQuery({ b2cRole: B2C_ADMIN });
  async function levelStaff(levelKey, ticket) {
    if (!levelKey) return [];
    return (await staffQuery({ b2cRole: levelKey })).filter(staff => eligibleForLevel(staff, levelKey, ticket));
  }
  // A level gets a named assignee only when exactly one person can take it;
  // otherwise it waits in that level's queue for someone to take ownership.
  async function autoAssignee(levelKey, ticket) {
    const eligible = await levelStaff(levelKey, ticket);
    return eligible.length === 1 ? person({ ...eligible[0], id: eligible[0]._id }) : null;
  }
  const addParticipant = (ticket, userId) => {
    if (userId && !(ticket.participants || []).some(item => idString(item) === idString(userId))) ticket.participants.push(userId);
  };

  // ---- Ingestion -----------------------------------------------------------------
  async function ingestMessage(inbox, raw) {
    const email = normaliseInboundEmail(raw, { maxBodyChars: config.maxBodyChars });
    if (!email.providerMessageId) throw new B2CError('Inbound message has no provider message id.');
    const dedupeKey = `${inbox.key}:${email.providerMessageId}`;
    const existing = await B2CInboundEmail.findOne({ $or: [{ dedupeKey }, ...(email.internetMessageId ? [{ internetMessageId: email.internetMessageId }] : [])] }).select('_id').lean();
    if (existing) return { duplicate: true, id: existing._id };
    const attachments = await storeAttachments(raw.attachments || [], { store: attachmentStore, maxBytes: config.maxAttachmentBytes, maxCount: config.maxAttachmentsPerEmail });
    try {
      const record = await B2CInboundEmail.create({ dedupeKey, inboxKey: inbox.key, inboxAddress: inbox.address, provider: inbox.provider, ...email, attachments, status: 'received' });
      return { duplicate: false, id: record._id };
    } catch (error) {
      await Promise.all(attachments.filter(item => item.storageKey).map(item => attachmentStore.remove(item.storageKey).catch(() => {})));
      if (error?.code === 11000) return { duplicate: true };
      throw error;
    }
  }

  async function pollInbox(inbox) {
    const described = emailConnectors.describe(inbox);
    const base = { kind: 'email', label: `Inbox · ${inbox.displayName || inbox.address}`, provider: inbox.provider, mode: described.mode };
    const key = `email:${inbox.key}`;
    try {
      const connector = emailConnectors.forInbox(inbox);
      const messages = await connector.fetchNew({ inbox, limit: config.pollBatchSize });
      let stored = 0;
      let duplicates = 0;
      for (const raw of messages) {
        const result = await ingestMessage(inbox, raw);
        if (result.duplicate) duplicates += 1; else stored += 1;
        // Only after the message is stored durably is it marked as read at the provider.
        await connector.markProcessed({ inbox, providerMessageId: raw.providerMessageId });
      }
      await recordIntegration(key, { ...base, ok: true, details: { fetched: messages.length, stored, duplicates } });
      return { inbox: inbox.key, fetched: messages.length, stored, duplicates };
    } catch (error) {
      await recordIntegration(key, { ...base, ok: false, error });
      logger.warn(`[B2C] Polling inbox ${inbox.key} failed: ${safeErrorMessage(error)}`);
      return { inbox: inbox.key, error: safeErrorMessage(error) };
    }
  }

  // ---- Processing ----------------------------------------------------------------
  async function claimNextInbound() {
    const at = now();
    return B2CInboundEmail.findOneAndUpdate(
      { $or: [{ status: 'received' }, { status: 'retrying', nextAttemptAt: { $lte: at } }, { status: 'processing', lockedUntil: { $lt: at } }] },
      { $set: { status: 'processing', lockedUntil: new Date(at.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
      { sort: { receivedAt: 1 }, new: true },
    );
  }

  async function processPendingInbound({ limit = 50 } = {}) {
    const results = [];
    for (let count = 0; count < limit; count += 1) {
      const record = await claimNextInbound();
      if (!record) break;
      try {
        results.push(await processInbound(record));
      } catch (error) {
        const permanent = error?.retryable === false || record.attempts >= config.maxProcessingAttempts;
        record.status = permanent ? 'failed' : 'retrying';
        record.lastError = safeErrorMessage(error);
        record.nextAttemptAt = permanent ? null : new Date(now().getTime() + backoffMs(record.attempts));
        record.lockedUntil = null;
        await record.save();
        logger.warn(`[B2C] Processing inbound ${record._id} failed (attempt ${record.attempts}): ${record.lastError}`);
        results.push({ id: record._id, status: record.status, error: record.lastError });
      }
    }
    return results;
  }

  async function processInbound(record) {
    const settings = await getSettings();
    const finish = async (status, outcome, ticketId) => {
      Object.assign(record, { status, outcome, processedAt: now(), lockedUntil: null, lastError: null, nextAttemptAt: null });
      if (ticketId) record.ticketId = ticketId;
      await record.save();
      return { id: record._id, status, outcome, ticketId: ticketId || null };
    };
    if (record.autoGenerated) return finish('ignored', `ignored_${record.autoGenerated}`);
    if (!record.from?.address) return finish('ignored', 'ignored_invalid_sender');
    if (settings.inboxes.some(inbox => inbox.address === record.from.address)) return finish('ignored', 'ignored_own_address');

    // A retry after a partial run continues from the ticket already linked.
    if (record.ticketId) {
      const linked = await B2CEscalation.findById(record.ticketId);
      if (linked && idString(linked.sourceEmailId) !== idString(record._id)) {
        await appendCustomerReply(linked, record);
        return finish('processed', 'appended_to_ticket', linked._id);
      }
    }
    const thread = await findThreadTicket(record);
    if (thread) {
      record.ticketId = thread._id;
      await record.save();
      await appendCustomerReply(thread, record);
      return finish('processed', 'appended_to_ticket', thread._id);
    }
    const ticket = await createTicketFromEmail(record, settings);
    return finish('processed', 'ticket_created', ticket._id);
  }

  async function findThreadTicket(record) {
    let ticket = null;
    const reference = ticketReferenceIn(record.subject, config.referencePrefix);
    if (reference) ticket = await B2CEscalation.findOne({ reference });
    const messageIds = [record.inReplyTo, ...(record.references || [])].filter(Boolean);
    if (!ticket && messageIds.length) {
      const outbound = await B2COutboundEmail.findOne({ messageId: { $in: messageIds } }).select('ticketId').lean();
      const inbound = outbound ? null : await B2CInboundEmail.findOne({ internetMessageId: { $in: messageIds }, ticketId: { $ne: null } }).select('ticketId').lean();
      const ticketId = outbound?.ticketId || inbound?.ticketId;
      if (ticketId) ticket = await B2CEscalation.findById(ticketId);
    }
    // Only the ticket's customer can add to its conversation. A reference
    // quoted by anyone else starts a separate escalation.
    if (ticket && ticket.customer?.email !== record.from.address) return null;
    return ticket;
  }

  async function appendCustomerReply(ticket, record) {
    const fromStatus = ticket.status;
    const toStatus = fromStatus === STATUS.AWAITING_CUSTOMER ? STATUS.INVESTIGATING : fromStatus;
    await B2CEscalation.updateOne({ _id: ticket._id, status: fromStatus }, { $set: { status: toStatus, lastCustomerMessageAt: record.receivedAt, lastActivityAt: now() }, $inc: { __v: 1 } });
    if (await B2CAuditEvent.exists({ ticketId: ticket._id, action: 'customer_replied', 'details.inboundId': String(record._id) })) return;
    const closed = [STATUS.RESOLVED, STATUS.CLOSED].includes(fromStatus);
    const recipients = ticket.workflow?.assignee?.userId ? [ticket.workflow.assignee] : await admins();
    const alerted = await notify(recipients, ticket, closed ? 'Customer replied after resolution' : 'Customer replied', `${ticket.reference}: the customer sent a new email${closed ? ` while the escalation is ${fromStatus.toLowerCase()}` : ''}.`);
    await audit(ticket, 'customer_replied', { fromStatus, toStatus: toStatus !== fromStatus ? toStatus : undefined, details: { inboundId: String(record._id), attachments: (record.attachments || []).length }, alerted });
  }

  async function createTicketFromEmail(record, settings) {
    let ticket = await B2CEscalation.findOne({ sourceEmailId: record._id });
    if (!ticket) {
      const inbox = settings.inboxes.find(item => item.key === record.inboxKey) || { key: record.inboxKey, address: record.inboxAddress };
      const identifiers = extractIdentifiers({ subject: record.subject, body: record.bodyText }, settings.identifierRules);
      const classification = classifyEscalation({ inbox, subject: record.subject, body: record.bodyText }, settings.classificationRules);
      try {
        ticket = await B2CEscalation.create({
          reference: await nextReference(), sourceEmailId: record._id, inboxKey: inbox.key, inboxAddress: inbox.address,
          subject: record.subject, summary: String(record.bodyText || '').slice(0, 500),
          category: classification.category, classification: { source: classification.source, matched: classification.matched, note: classification.reason },
          identifiers, customer: { email: record.from.address, name: record.from.name || '' }, region: inbox.defaultRegion || '',
          status: STATUS.TRIAGE, triage: { reasons: [] }, workflow: { path: [], currentLevel: null }, crm: { status: 'pending' },
          ...slaTargets(STANDARD_PRIORITY, now()),
          lastCustomerMessageAt: record.receivedAt, lastActivityAt: now(),
        });
      } catch (error) {
        if (error?.code !== 11000 || !error.keyPattern?.sourceEmailId) throw error;
        ticket = await B2CEscalation.findOne({ sourceEmailId: record._id });
      }
    }
    // Linked before the remaining steps so a retry resumes this ticket.
    record.ticketId = ticket._id;
    await record.save();
    await auditOnce(ticket, 'created_from_email', { toStatus: STATUS.TRIAGE, details: { inbox: ticket.inboxKey, identifierTypes: ticket.identifiers.map(item => item.type), category: ticket.category, classifiedBy: ticket.classification?.source || 'none' } });
    if (ticket.crm.status === 'pending') await enrichFromCrm(ticket);
    if (ticket.status === STATUS.TRIAGE && !ticket.triage?.resolvedAt) await evaluateTriage(ticket, settings);
    await queueAcknowledgement(ticket);
    return ticket;
  }

  // ---- CRM ------------------------------------------------------------------------
  async function enrichFromCrm(ticket, actor = SYSTEM) {
    const integration = { kind: 'crm', label: 'Customer database (CRM)', provider: crmConnector.provider, mode: crmConnector.isConfigured() ? crmConnector.mode : 'not_configured' };
    if (!crmConnector.isConfigured()) {
      ticket.crm = { status: 'not_configured', provider: crmConnector.provider, mode: 'not_configured', fetchedAt: now(), attempts: ticket.crm?.attempts || 0 };
      await ticket.save();
      await auditOnce(ticket, 'crm_not_configured', { details: { provider: crmConnector.provider } });
      return ticket;
    }
    const attempts = (ticket.crm?.attempts || 0) + 1;
    const of = type => ticket.identifiers.filter(item => item.type === type).map(item => item.value);
    let timer;
    try {
      const lookup = crmConnector.lookup({ caseIds: of('caseId'), serialNumbers: of('serialNumber'), email: ticket.customer?.email });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('CRM lookup timed out'), { retryable: true })), config.crmTimeoutMs); });
      const { matches = [] } = await Promise.race([lookup, timeout]);
      const status = matches.length === 1 ? 'matched' : matches.length ? 'multiple_matches' : 'no_match';
      if (status === 'matched') {
        const [match] = matches;
        ticket.customer = { email: ticket.customer.email, name: match.customer?.name || ticket.customer.name, phone: match.customer?.phone || '', crmCustomerId: match.customer?.crmCustomerId || '' };
        if (match.customer?.region) ticket.region = String(match.customer.region).slice(0, 80);
        ticket.devices = (match.devices || []).slice(0, 20).map(device => ({ serialNumber: device.serialNumber, model: device.model, productName: device.productName, purchaseDate: device.purchaseDate ? new Date(device.purchaseDate) : undefined, warrantyStatus: device.warrantyStatus, crmDeviceId: device.crmDeviceId }));
        ticket.crmCases = (match.cases || []).slice(0, 20).map(item => ({ caseId: item.caseId, status: item.status, openedAt: item.openedAt ? new Date(item.openedAt) : undefined, description: String(item.description || '').slice(0, 500) }));
      }
      ticket.crm = { status, provider: crmConnector.provider, mode: crmConnector.mode, fetchedAt: now(), attempts, matchCount: matches.length, lastError: null, nextAttemptAt: null };
      await ticket.save();
      await recordIntegration('crm', { ...integration, ok: true });
      await audit(ticket, 'crm_lookup', { actor, details: { result: status, matchedBy: matches[0]?.matchedBy || null, matchCount: matches.length } });
    } catch (error) {
      const retry = error?.retryable !== false && attempts < config.maxCrmAttempts;
      ticket.crm = { status: 'error', provider: crmConnector.provider, mode: crmConnector.mode, fetchedAt: now(), attempts, lastError: safeErrorMessage(error), nextAttemptAt: retry ? new Date(now().getTime() + backoffMs(attempts)) : null };
      await ticket.save();
      await recordIntegration('crm', { ...integration, ok: false, error });
      await audit(ticket, 'crm_lookup_failed', { actor, details: { attempt: attempts, willRetry: retry, error: safeErrorMessage(error) } });
    } finally { clearTimeout(timer); }
    return ticket;
  }

  async function retryCrmLookups({ limit = 20 } = {}) {
    if (!crmConnector.isConfigured()) return [];
    const settings = await getSettings();
    const due = await B2CEscalation.find({ 'crm.status': 'error', 'crm.nextAttemptAt': { $lte: now() }, status: { $in: ACTIVE_STATUSES } }).limit(limit);
    for (const ticket of due) {
      await enrichFromCrm(ticket);
      if (ticket.status === STATUS.TRIAGE && !ticket.triage?.resolvedAt) await evaluateTriage(ticket, settings);
    }
    return due.map(ticket => ticket.reference);
  }

  // ---- Triage and routing ------------------------------------------------------------
  function triageReasons(ticket) {
    const reasons = [];
    if (!ticket.identifiers?.length) reasons.push('missing_identifier');
    if (ticket.category === UNCLASSIFIED) reasons.push(ticket.classification?.note === 'ambiguous_category' ? 'ambiguous_category' : 'unclassified_category');
    if (ticket.crm?.status === 'no_match') reasons.push('crm_no_match');
    if (ticket.crm?.status === 'multiple_matches') reasons.push('crm_multiple_matches');
    if (ticket.crm?.status === 'error') reasons.push('crm_error');
    return reasons;
  }

  async function evaluateTriage(ticket, settings) {
    const reasons = triageReasons(ticket);
    if (reasons.length) {
      const changed = reasons.join() !== (ticket.triage?.reasons || []).join();
      ticket.triage = { reasons };
      await ticket.save();
      if (changed) {
        const alerted = await notify(await admins(), ticket, 'Escalation needs triage', `${ticket.reference} needs review before it can be routed (${reasons.map(reason => reason.replace(/_/g, ' ')).join(', ')}).`);
        await audit(ticket, 'queued_for_triage', { details: { reasons }, alerted });
      }
      return false;
    }
    await routeToWorkflow(ticket, settings, SYSTEM);
    return true;
  }

  async function routeToWorkflow(ticket, settings, actor) {
    const path = defaultPath(settings);
    if (!path.length) {
      ticket.triage = { reasons: ['no_workflow_path'] };
      await ticket.save();
      await audit(ticket, 'queued_for_triage', { actor, details: { reasons: ['no_workflow_path'] } });
      return;
    }
    const fromStatus = ticket.status;
    const assignee = await autoAssignee(path[0], ticket);
    ticket.workflow = { path, currentLevel: path[0], assignee, assignedAt: assignee ? now() : null };
    ticket.status = statusForAssignment(assignee);
    ticket.triage = { reasons: [], resolvedAt: now(), resolvedBy: actor.name };
    if (assignee) addParticipant(ticket, assignee.userId);
    ticket.lastActivityAt = now();
    await ticket.save();
    const alerted = await notifyLevel(ticket, settings, 'New escalation');
    await audit(ticket, 'routed', { actor, fromStatus, toStatus: ticket.status, details: { level: levelLabel(settings, path[0]), assignee: assignee?.name || null, path: path.map(key => levelLabel(settings, key)) }, alerted });
  }

  // Tells the assignee, or everyone who could take the ticket at its level.
  async function notifyLevel(ticket, settings, title) {
    const level = levelLabel(settings, ticket.workflow?.currentLevel);
    if (ticket.workflow?.assignee?.userId) return notify([ticket.workflow.assignee], ticket, title, `${ticket.reference} (${ticket.category}) is assigned to you as ${level}.`);
    const pool = await levelStaff(ticket.workflow?.currentLevel, ticket);
    return notify(pool.length ? pool : await admins(), ticket, title, `${ticket.reference} (${ticket.category}) is waiting for a ${level} to take ownership.`);
  }

  // ---- SLA escalation ------------------------------------------------------------------
  // The same calculation and rules as B2B service tickets (the all-priorities rules, as B2C has no priority): "At Risk" at the approaching
  // threshold, "SLA Breached"/"Escalated" at the breach thresholds, levels 1–3. The owner
  // stays the same; each level notifies further up the ticket's path.
  const SLA_MONITOR = { userId: null, name: 'SLA Monitor', role: 'system' };
  async function slaRecipients(ticket, settings, level) {
    const path = effectivePath(ticket, settings);
    const index = Math.max(0, path.indexOf(ticket.workflow?.currentLevel));
    const owner = ticket.workflow?.assignee?.userId ? [ticket.workflow.assignee] : await levelStaff(ticket.workflow?.currentLevel, ticket);
    const above = [];
    for (let step = 1; step < level; step += 1) above.push(...await levelStaff(path[index + step], ticket));
    return [...owner, ...above, ...(level >= 2 || !owner.length ? await admins() : [])];
  }
  async function evaluateSla(ticket, settings, rules) {
    const escalation = computeSlaEscalation(ticket, rules, now().getTime());
    if (!escalation) return false;
    const { update, nextStatus, level, reason, changed } = escalation;
    // Conditional on the state read, so concurrent evaluations record an escalation once.
    const result = await B2CEscalation.updateOne({ _id: ticket._id, slaStatus: ticket.slaStatus ?? null, escalationStatus: ticket.escalationStatus ?? null, escalationLevel: ticket.escalationLevel ?? null }, { $set: update });
    if (result.modifiedCount !== 1) return false;
    if (typeof ticket.set === 'function') ticket.set(update); else Object.assign(ticket, update);
    if (changed) {
      const alerted = await notify(await slaRecipients(ticket, settings, level), ticket, nextStatus === 'SLA Breached' ? 'SLA breached' : 'SLA approaching', `${ticket.reference} is ${nextStatus.toLowerCase()}. ${reason}. Escalated to Level ${level}.`);
      await audit(ticket, 'sla_escalation', { actor: SLA_MONITOR, note: `${reason}. Escalated to Level ${level}.`, details: { slaStatus: nextStatus, level }, alerted });
    }
    return true;
  }
  async function evaluateSlaEscalations() {
    const [settings, rules] = await Promise.all([getSettings(), escalationRules()]);
    if (!rules.length) return [];
    const tickets = await B2CEscalation.find({ status: { $in: ACTIVE_STATUSES }, slaTargetAt: { $ne: null } }).limit(500);
    const escalated = [];
    for (const ticket of tickets) if (await evaluateSla(ticket, settings, rules)) escalated.push(ticket._id);
    return escalated;
  }

  // ---- Outbound email ----------------------------------------------------------------
  async function queueOutbound(ticket, { kind, templateKey, vars = {}, dedupeKey, createdBy }) {
    try {
      return await B2COutboundEmail.create({ dedupeKey, ticketId: ticket._id, inboxKey: ticket.inboxKey, kind, templateKey, vars, to: ticket.customer.email, status: 'queued', nextAttemptAt: now(), createdBy });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      return B2COutboundEmail.findOne({ dedupeKey });
    }
  }

  async function queueAcknowledgement(ticket) {
    if (ticket.acknowledgement?.outboundId) return;
    const outbound = await queueOutbound(ticket, { kind: 'acknowledgement', templateKey: 'acknowledgement', dedupeKey: `ack:${ticket._id}` });
    ticket.acknowledgement = { status: 'queued', outboundId: outbound._id };
    await ticket.save();
    await auditOnce(ticket, 'acknowledgement_queued');
  }

  async function syncAcknowledgement(outbound, status, sentAt) {
    if (outbound.kind !== 'acknowledgement') return;
    await B2CEscalation.updateOne({ _id: outbound.ticketId }, { $set: { 'acknowledgement.status': status, ...(sentAt ? { 'acknowledgement.sentAt': sentAt } : {}) } });
  }

  async function sendOutbound(outbound, settings) {
    const template = settings.templates.find(item => item.key === outbound.templateKey);
    if (!template?.approved) {
      // Automated customer email only uses wording TCM has approved.
      Object.assign(outbound, { status: 'held', heldReason: 'template_not_approved', lockedUntil: null, attempts: Math.max(0, outbound.attempts - 1) });
      await outbound.save();
      await syncAcknowledgement(outbound, 'held');
      return outbound;
    }
    const ticket = await B2CEscalation.findById(outbound.ticketId).lean();
    const inbox = settings.inboxes.find(item => item.key === outbound.inboxKey);
    const described = inbox ? emailConnectors.describe(inbox) : { mode: 'disabled' };
    const integration = { kind: 'outbound', label: 'Outbound customer email', provider: inbox?.provider, mode: described.mode };
    try {
      if (!ticket) throw Object.assign(new Error('Escalation no longer exists'), { retryable: false });
      if (!inbox) throw Object.assign(new Error(`Inbox "${outbound.inboxKey}" is no longer configured`), { retryable: false });
      const connector = emailConnectors.forInbox(inbox);
      const rendered = renderTemplate(template, templateVars(ticket, outbound.vars));
      outbound.messageId = outbound.messageId || `<${outbound._id}.${crypto.randomBytes(6).toString('hex')}@${config.messageIdDomain}>`;
      outbound.subject = rendered.subject;
      outbound.bodyText = rendered.body;
      const result = await connector.send({ inbox, to: outbound.to, subject: rendered.subject, text: rendered.body, messageId: outbound.messageId, reference: ticket.reference });
      Object.assign(outbound, { status: 'sent', sentAt: now(), providerMessageId: result?.providerMessageId || null, mode: connector.mode, lockedUntil: null, lastError: null, heldReason: null });
      await outbound.save();
      await syncAcknowledgement(outbound, 'sent', outbound.sentAt);
      await recordIntegration('outbound', { ...integration, ok: true });
      await audit(ticket, 'email_sent', { details: { kind: outbound.kind, mode: connector.mode } });
    } catch (error) {
      const permanent = error?.retryable === false || outbound.attempts >= config.maxSendAttempts;
      Object.assign(outbound, { status: permanent ? 'failed' : 'retrying', lastError: safeErrorMessage(error), nextAttemptAt: permanent ? null : new Date(now().getTime() + backoffMs(outbound.attempts)), lockedUntil: null });
      await outbound.save();
      if (permanent) await syncAcknowledgement(outbound, 'failed');
      await recordIntegration('outbound', { ...integration, ok: false, error });
      if (ticket) await audit(ticket, 'email_send_failed', { details: { kind: outbound.kind, attempt: outbound.attempts, willRetry: !permanent, error: safeErrorMessage(error) } });
    }
    return outbound;
  }

  async function sendPendingOutbound({ limit = 50 } = {}) {
    const settings = await getSettings();
    // Held messages go back into the queue once their template is approved.
    const approved = settings.templates.filter(item => item.approved).map(item => item.key);
    if (approved.length) await B2COutboundEmail.updateMany({ status: 'held', heldReason: 'template_not_approved', templateKey: { $in: approved } }, { $set: { status: 'queued', heldReason: null, nextAttemptAt: now() } });
    const results = [];
    for (let count = 0; count < limit; count += 1) {
      const at = now();
      const outbound = await B2COutboundEmail.findOneAndUpdate(
        { $or: [{ status: 'queued' }, { status: 'retrying', nextAttemptAt: { $lte: at } }, { status: 'sending', lockedUntil: { $lt: at } }] },
        { $set: { status: 'sending', lockedUntil: new Date(at.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, new: true },
      );
      if (!outbound) break;
      const sent = await sendOutbound(outbound, settings);
      results.push({ id: sent._id, kind: sent.kind, status: sent.status });
    }
    return results;
  }

  // ---- One processing cycle ------------------------------------------------------------
  async function runCycle(trigger = 'scheduled') {
    if (scheduler.running) return { skipped: true, reason: 'A run is already in progress.' };
    scheduler.running = true;
    try {
      const settings = await getSettings();
      const polled = [];
      for (const inbox of settings.inboxes.filter(item => item.enabled)) polled.push(await pollInbox(inbox));
      const processed = await processPendingInbound();
      const crmRetried = await retryCrmLookups();
      const sent = await sendPendingOutbound();
      const slaEscalated = await evaluateSlaEscalations();
      scheduler.lastResult = { trigger, polled, processed: processed.length, crmRetried: crmRetried.length, sent: sent.length, slaEscalated: slaEscalated.length };
      scheduler.lastError = null;
      return scheduler.lastResult;
    } catch (error) {
      scheduler.lastError = safeErrorMessage(error);
      logger.error(`[B2C] Processing cycle failed: ${scheduler.lastError}`);
      throw error;
    } finally {
      scheduler.running = false;
      scheduler.lastRunAt = now();
      await recordIntegration('scheduler', { kind: 'scheduler', label: 'Email processing cycle', provider: 'internal', mode: 'live', ok: !scheduler.lastError, error: scheduler.lastError ? new Error(scheduler.lastError) : null, details: scheduler.lastResult || {} }).catch(() => {});
    }
  }

  // ---- Workflow actions ------------------------------------------------------------------
  const LIMITS = { reason: 1000, message: 5000, note: 5000, resolutionSummary: 5000, customerMessage: 5000 };
  function requiredText(payload, field) {
    const value = typeof payload?.[field] === 'string' ? payload[field].trim() : '';
    if (!value) throw new B2CError(`${field === 'customerMessage' ? 'The customer message' : field === 'resolutionSummary' ? 'A resolution summary' : `A ${field}`} is required.`);
    if (value.length > LIMITS[field]) throw new B2CError(`${field} must be ${LIMITS[field]} characters or fewer.`);
    return value;
  }
  const optionalText = (payload, field, max) => (typeof payload?.[field] === 'string' && payload[field].trim() ? payload[field].trim().slice(0, max) : '');

  async function loadVisibleTicket(id, user) {
    if (!mongoose.isValidObjectId(id)) throw new B2CError('Escalation not found', 404);
    const ticket = await B2CEscalation.findById(id);
    // Tickets the user may not see are reported as not found, not forbidden.
    if (!ticket || !canView(ticket, user)) throw new B2CError('Escalation not found', 404);
    return ticket;
  }

  async function chooseStaff(userId, levelKey, ticket) {
    if (!mongoose.isValidObjectId(userId)) throw new B2CError('Choose a valid staff member.');
    const staff = await User.findOne({ _id: userId, role: { $in: STAFF_ROLES } }).select('_id name email b2cRole b2cRegions').lean();
    if (!staff || !eligibleForLevel(staff, levelKey, ticket)) throw new B2CError('That staff member does not hold this level for the escalation\'s region.');
    return person({ ...staff, id: staff._id });
  }

  function cleanIdentifiers(list) {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 10) throw new B2CError('Up to 10 identifiers can be added.');
    return list.map(item => {
      if (!IDENTIFIER_TYPES.includes(item?.type)) throw new B2CError('Identifier type is invalid.');
      const value = String(item.value || '').trim();
      if (!value || value.length > 60 || !/^[\w./-]+$/.test(value)) throw new B2CError('Identifier values are 1–60 letters, digits or -./_ characters.');
      return { type: item.type, value: ['caseId', 'serialNumber'].includes(item.type) ? value.toUpperCase() : value, ruleKey: 'manual', source: 'manual' };
    });
  }

  async function resolveTicket(ticket, { summary, customerMessage, user }) {
    ticket.status = STATUS.RESOLVED;
    ticket.resolution = { summary, resolvedBy: person(user), resolvedAt: now() };
    const outbound = await queueOutbound(ticket, { kind: 'final', templateKey: 'final_resolution', vars: { message: customerMessage }, dedupeKey: `final:${ticket._id}:${ticket.reopenCount || 0}`, createdBy: person(user) });
    ticket.resolution.finalMessageId = outbound._id;
  }

  async function performAction(id, action, payload = {}, user) {
    if (!ACTIONS[action]) throw new B2CError('Unknown action', 404);
    const settings = await getSettings();
    const ticket = await loadVisibleTicket(id, user);
    if (!canPerform(action, { ticket, user, settings })) throw new B2CError(`You cannot ${ACTIONS[action].label.toLowerCase()} this escalation in its current state.`, 403);
    const fromStatus = ticket.status;
    const details = {};
    let note;
    let afterSave = async () => {};

    switch (action) {
      case 'complete_triage': {
        if (!CATEGORIES.includes(payload.category)) throw new B2CError('Choose Service or Retail.');
        const added = cleanIdentifiers(payload.identifiers);
        const known = new Set(ticket.identifiers.map(item => `${item.type}:${item.value}`));
        added.filter(item => !known.has(`${item.type}:${item.value}`)).forEach(item => ticket.identifiers.push(item));
        if (payload.region !== undefined) ticket.region = String(payload.region || '').trim().slice(0, 80);
        details.overriddenReasons = [...(ticket.triage?.reasons || [])];
        if (ticket.category !== payload.category) ticket.classification = { source: 'manual', matched: [], note: null };
        ticket.category = payload.category;
        note = optionalText(payload, 'note', LIMITS.note);
        if ((added.length || payload.rerunCrm) && crmConnector.isConfigured()) await enrichFromCrm(ticket, user);
        await audit(ticket, 'triage_completed', { actor: user, fromStatus, details: { category: ticket.category, addedIdentifiers: added.map(item => item.type), overriddenReasons: details.overriddenReasons }, note });
        await routeToWorkflow(ticket, settings, user);
        return getTicketDetail(id, user);
      }
      case 'retry_crm': {
        if (!crmConnector.isConfigured()) throw new B2CError('The CRM connector is not configured.', 409);
        ticket.crm.attempts = 0;
        await enrichFromCrm(ticket, user);
        if (ticket.status === STATUS.TRIAGE && !ticket.triage?.resolvedAt) await evaluateTriage(ticket, settings);
        return getTicketDetail(id, user);
      }
      // Taking ownership is accepting the work, so it skips "Engineer assigned".
      case 'claim':
        ticket.workflow.assignee = person(user);
        ticket.workflow.assignedAt = now();
        ticket.status = STATUS.ACCEPTED;
        break;
      case 'accept':
        ticket.status = STATUS.ACCEPTED;
        break;
      case 'assign': {
        const assignee = await chooseStaff(payload.userId, ticket.workflow.currentLevel, ticket);
        details.from = ticket.workflow.assignee?.name || null;
        details.to = assignee.name;
        ticket.workflow.assignee = assignee;
        ticket.workflow.assignedAt = now();
        addParticipant(ticket, assignee.userId);
        if (ticket.status !== STATUS.AWAITING_CUSTOMER) ticket.status = STATUS.ASSIGNED;
        afterSave = () => notify([assignee], ticket, 'Escalation assigned to you', `${ticket.reference} (${ticket.category}) was assigned to you by ${user.name}.`);
        break;
      }
      case 'start':
        ticket.status = STATUS.INVESTIGATING;
        break;
      case 'reroute': {
        note = requiredText(payload, 'reason');
        const target = payload.levelKey;
        if (!enabledLevels(settings).some(level => level.key === target)) throw new B2CError('Choose an enabled workflow level.');
        if (!ticket.workflow.path.includes(target)) {
          const index = ticket.workflow.path.indexOf(ticket.workflow.currentLevel);
          ticket.workflow.path.splice(index + 1, 0, target);
        }
        const assignee = payload.userId ? await chooseStaff(payload.userId, target, ticket) : await autoAssignee(target, ticket);
        Object.assign(details, { fromLevel: levelLabel(settings, ticket.workflow.currentLevel), toLevel: levelLabel(settings, target), assignee: assignee?.name || null });
        ticket.workflow.currentLevel = target;
        ticket.workflow.assignee = assignee;
        ticket.workflow.assignedAt = assignee ? now() : null;
        if (assignee) addParticipant(ticket, assignee.userId);
        ticket.status = statusForAssignment(assignee);
        afterSave = () => notifyLevel(ticket, settings, 'Escalation rerouted');
        break;
      }
      case 'set_path': {
        const path = Array.isArray(payload.path) ? payload.path : [];
        const enabled = new Set(enabledLevels(settings).map(level => level.key));
        if (!path.length || path.some(key => !enabled.has(key)) || new Set(path).size !== path.length) throw new B2CError('The path must list enabled levels, each once.');
        if (!path.includes(ticket.workflow.currentLevel)) throw new B2CError('The path must include the current level. Use Reroute to move the escalation.');
        details.path = path.map(key => levelLabel(settings, key));
        ticket.workflow.path = path;
        break;
      }
      case 'request_clarification': {
        const message = requiredText(payload, 'message');
        ticket.status = STATUS.AWAITING_CUSTOMER;
        afterSave = () => queueOutbound(ticket, { kind: 'clarification', templateKey: 'clarification', vars: { message }, dedupeKey: `clarification:${ticket._id}:${crypto.randomUUID()}`, createdBy: person(user) });
        break;
      }
      case 'propose_resolution': {
        const resolutionSummary = requiredText(payload, 'resolutionSummary');
        const customerMessage = requiredText(payload, 'customerMessage');
        const validatorLevel = validatorLevelFor(ticket, settings);
        if (validatorLevel === false) {
          await resolveTicket(ticket, { summary: resolutionSummary, customerMessage, user });
          details.validation = 'not required';
        } else {
          ticket.status = STATUS.PENDING_VALIDATION;
          ticket.validation = { validatorLevel, proposedBy: person(user), proposedAt: now(), resolutionSummary, customerMessage, decision: null };
          details.validator = validatorLevel ? levelLabel(settings, validatorLevel) : 'B2C admin';
          afterSave = async () => {
            const validators = validatorLevel ? await levelStaff(validatorLevel, ticket) : [];
            return notify(validators.length ? validators : await admins(), ticket, 'Resolution awaiting validation', `${ticket.reference}: ${user.name} submitted a resolution for validation.`);
          };
        }
        note = resolutionSummary;
        break;
      }
      case 'approve_resolution': {
        const customerMessage = optionalText(payload, 'customerMessage', LIMITS.customerMessage) || ticket.validation.customerMessage;
        ticket.validation.decision = 'approved';
        ticket.validation.decidedBy = person(user);
        ticket.validation.decidedAt = now();
        ticket.validation.customerMessage = customerMessage;
        await resolveTicket(ticket, { summary: ticket.validation.resolutionSummary, customerMessage, user });
        note = optionalText(payload, 'note', LIMITS.note);
        afterSave = () => notify([ticket.validation.proposedBy], ticket, 'Resolution approved', `${ticket.reference}: ${user.name} approved the resolution. The final customer email has been queued.`);
        break;
      }
      case 'reject_resolution':
        note = requiredText(payload, 'reason');
        ticket.validation.decision = 'rejected';
        ticket.validation.rejectionReason = note;
        ticket.validation.decidedBy = person(user);
        ticket.validation.decidedAt = now();
        ticket.status = STATUS.INVESTIGATING;
        afterSave = () => notify([ticket.validation.proposedBy], ticket, 'Resolution returned for rework', `${ticket.reference}: ${user.name} returned the resolution for rework.`);
        break;
      case 'close':
        ticket.status = STATUS.CLOSED;
        ticket.closedAt = now();
        ticket.closure = { reason: 'Resolved', by: person(user) };
        note = optionalText(payload, 'note', LIMITS.note);
        break;
      case 'close_unresolved': {
        note = requiredText(payload, 'reason');
        const customerMessage = optionalText(payload, 'customerMessage', LIMITS.customerMessage);
        ticket.status = STATUS.CLOSED;
        ticket.closedAt = now();
        ticket.closure = { reason: note, by: person(user) };
        details.customerNotified = Boolean(customerMessage);
        if (customerMessage) afterSave = () => queueOutbound(ticket, { kind: 'final', templateKey: 'final_resolution', vars: { message: customerMessage }, dedupeKey: `final:${ticket._id}:${ticket.reopenCount || 0}`, createdBy: person(user) });
        break;
      }
      case 'reopen':
        note = requiredText(payload, 'reason');
        ticket.status = STATUS.REOPENED;
        ticket.reopenCount = (ticket.reopenCount || 0) + 1;
        ticket.closedAt = null;
        ticket.validation = {};
        afterSave = () => notifyLevel(ticket, settings, 'Escalation reopened');
        break;
      case 'add_note':
        note = requiredText(payload, 'note');
        break;
      default:
        throw new B2CError('Unknown action', 404);
    }

    addParticipant(ticket, user.id);
    ticket.lastActivityAt = now();
    try { await ticket.save(); } catch (error) {
      if (error instanceof mongoose.Error.VersionError) throw new B2CError('This escalation was updated by someone else. Reload it and try again.', 409);
      throw error;
    }
    const alerted = await afterSave();
    await audit(ticket, action, { actor: user, fromStatus, toStatus: ticket.status !== fromStatus ? ticket.status : undefined, note, details, alerted: Array.isArray(alerted) ? alerted : [] });
    return getTicketDetail(id, user);
  }

  // ---- Queries ----------------------------------------------------------------------------
  async function staffForUser() {
    const staff = await staffQuery({ b2cRole: { $in: B2C_ROLES } });
    return staff.map(item => ({ _id: item._id, name: item.name, email: item.email, b2cRole: item.b2cRole, b2cRegions: item.b2cRegions || [] }));
  }

  async function getTicketDetail(id, user) {
    const settings = await getSettings();
    const ticket = await loadVisibleTicket(id, user);
    // Evaluated on read as well, like B2B tickets, so the SLA shown is current.
    await evaluateSla(ticket, settings, await escalationRules());
    const [inbound, outbound, auditTrail] = await Promise.all([
      B2CInboundEmail.find({ ticketId: ticket._id }).select('from to cc subject bodyText bodyTruncated receivedAt attachments autoGenerated status outcome').sort({ receivedAt: 1 }).lean(),
      B2COutboundEmail.find({ ticketId: ticket._id }).select('kind to subject bodyText status heldReason lastError sentAt createdAt mode createdBy attempts templateKey vars').sort({ createdAt: 1 }).lean(),
      B2CAuditEvent.find({ ticketId: ticket._id }).sort({ at: 1 }).lean(),
    ]);
    const conversation = [
      ...inbound.map(item => ({ _id: item._id, direction: 'inbound', at: item.receivedAt, from: item.from, to: item.to, subject: item.subject, bodyText: item.bodyText, bodyTruncated: item.bodyTruncated, attachments: (item.attachments || []).map(({ storageKey, ...rest }) => ({ ...rest, downloadKey: storageKey || null })) })),
      ...outbound.map(item => {
        // Unsent messages show what will be sent; sent ones show what was sent.
        const template = settings.templates.find(entry => entry.key === item.templateKey);
        const preview = item.status === 'sent' ? null : renderTemplate(template, templateVars(ticket, item.vars));
        return { _id: item._id, direction: 'outbound', kind: item.kind, at: item.sentAt || item.createdAt, to: item.to, subject: item.subject || preview?.subject, bodyText: item.bodyText || preview?.body, status: item.status, heldReason: item.heldReason, lastError: item.lastError, mode: item.mode, attempts: item.attempts, createdBy: item.createdBy };
      }),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
    const plain = ticket.toObject();
    return {
      ticket: { ...plain, path: effectivePath(plain, settings) },
      conversation,
      audit: auditTrail,
      allowedActions: allowedActions({ ticket, user, settings }),
      workflow: {
        levels: enabledLevels(settings).map(level => ({ key: level.key, label: level.label })),
        nextLevel: nextLevel(ticket, settings),
        validatorLevel: ticket.status === STATUS.INVESTIGATING ? validatorLevelFor(ticket, settings) : ticket.validation?.validatorLevel ?? null,
        validationMode: settings.validation?.mode || 'next_level',
      },
      templates: Object.fromEntries(settings.templates.map(item => [item.key, { approved: Boolean(item.approved), subject: item.subject, body: item.body }])),
      crmConfigured: crmConnector.isConfigured(),
    };
  }

  function buildListFilter(query, user) {
    const and = [visibilityFilter(user)];
    const pick = value => (typeof value === 'string' && value && value !== 'All' ? value.slice(0, 80) : null);
    const status = pick(query.status);
    if (status === 'active') and.push({ status: { $in: ACTIVE_STATUSES } });
    else if (status) and.push({ status });
    for (const field of ['category', 'region', 'inboxKey', 'slaStatus', 'escalationStatus']) { const value = pick(query[field]); if (value) and.push({ [field]: value }); }
    const level = pick(query.level);
    if (level) and.push({ 'workflow.currentLevel': level });
    const assignee = pick(query.assignee);
    if (assignee === 'me') and.push({ 'workflow.assignee.userId': user.id });
    else if (assignee === 'unassigned') and.push({ 'workflow.assignee.userId': null, status: { $in: [STATUS.OPEN, STATUS.REOPENED] } });
    else if (assignee && isAdmin(user) && mongoose.isValidObjectId(assignee)) and.push({ 'workflow.assignee.userId': assignee });
    if (pick(query.queue) === 'validation') and.push({ status: STATUS.PENDING_VALIDATION });
    const age = AGE_BUCKETS.findIndex(([label]) => label === pick(query.ageing));
    if (age >= 0) {
      const day = 86_400_000;
      const upper = new Date(now().getTime() - (age === 0 ? 0 : AGE_BUCKETS[age - 1][1]) * day);
      const lower = Number.isFinite(AGE_BUCKETS[age][1]) ? new Date(now().getTime() - AGE_BUCKETS[age][1] * day) : null;
      and.push({ status: { $in: ACTIVE_STATUSES }, createdAt: { $lte: upper, ...(lower ? { $gt: lower } : {}) } });
    }
    for (const [field, op] of [['from', '$gte'], ['to', '$lt']]) {
      const value = pick(query[field]);
      if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const date = new Date(`${value}T00:00:00+05:30`);
        and.push({ createdAt: { [op]: field === 'to' ? new Date(date.getTime() + 86_400_000) : date } });
      }
    }
    const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
    if (search) {
      const pattern = { $regex: escapeRegex(search), $options: 'i' };
      and.push({ $or: [{ reference: pattern }, { subject: pattern }, { 'customer.email': pattern }, { 'customer.name': pattern }, { 'identifiers.value': pattern }, { 'devices.serialNumber': pattern }] });
    }
    return { $and: and };
  }

  async function listTickets(query, user) {
    const filter = buildListFilter(query, user);
    const sortField = SORTABLE.includes(query.sort) ? query.sort : 'createdAt';
    const order = query.order === 'asc' ? 1 : -1;
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 25));
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const [items, total, regions] = await Promise.all([
      B2CEscalation.find(filter).select('reference subject category status region customer.name customer.email identifiers workflow triage crm.status acknowledgement.status createdAt updatedAt lastActivityAt lastCustomerMessageAt reopenCount slaStatus slaTargetAt escalationLevel escalationStatus').sort({ [sortField]: order, _id: order }).skip((page - 1) * limit).limit(limit).lean(),
      B2CEscalation.countDocuments(filter),
      B2CEscalation.distinct('region', visibilityFilter(user)),
    ]);
    return { items, total, page, limit, facets: { regions: regions.filter(Boolean).sort() } };
  }

  async function dashboard(user) {
    const settings = await getSettings();
    const visible = visibilityFilter(user);
    const tickets = await B2CEscalation.find(visible).select('status category region workflow validation createdAt resolution.resolvedAt slaStatus escalationStatus').lean();
    const count = predicate => tickets.filter(predicate).length;
    const active = tickets.filter(ticket => ACTIVE_STATUSES.includes(ticket.status));
    const group = (items, pick) => Object.entries(items.reduce((result, item) => { const key = pick(item) || 'Not set'; result[key] = (result[key] || 0) + 1; return result; }, {})).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    const monthAgo = now().getTime() - 30 * 86_400_000;
    const recent = await B2CEscalation.find({ $and: [visible, { status: { $in: ACTIVE_STATUSES } }] }).select('reference subject category status region workflow createdAt lastActivityAt').sort({ lastActivityAt: -1 }).limit(8).lean();
    const result = {
      role: user.b2cRole,
      summary: {
        active: active.length,
        triage: count(ticket => ticket.status === STATUS.TRIAGE),
        unassigned: count(ticket => [STATUS.OPEN, STATUS.REOPENED].includes(ticket.status) && !ticket.workflow?.assignee?.userId),
        mine: count(ticket => idString(ticket.workflow?.assignee?.userId) === idString(user.id) && ACTIVE_STATUSES.includes(ticket.status)),
        awaitingCustomer: count(ticket => ticket.status === STATUS.AWAITING_CUSTOMER),
        pendingValidation: count(ticket => ticket.status === STATUS.PENDING_VALIDATION),
        slaAtRisk: active.filter(ticket => ticket.slaStatus === 'At Risk').length,
        slaBreached: active.filter(ticket => ticket.slaStatus === 'SLA Breached').length,
        resolved30d: count(ticket => ticket.resolution?.resolvedAt && new Date(ticket.resolution.resolvedAt).getTime() >= monthAgo),
      },
      byStatus: group(tickets, ticket => ticket.status),
      byCategory: group(active, ticket => ticket.category),
      byRegion: group(active, ticket => ticket.region),
      byLevel: group(active.filter(ticket => ticket.workflow?.currentLevel), ticket => levelLabel(settings, ticket.workflow.currentLevel)),
      recent,
    };
    if (isAdmin(user)) {
      const [failedInbound, heldOutbound, failedOutbound, integrationErrors] = await Promise.all([
        B2CInboundEmail.countDocuments({ status: { $in: ['failed', 'retrying'] } }),
        B2COutboundEmail.countDocuments({ status: 'held' }),
        B2COutboundEmail.countDocuments({ status: { $in: ['failed', 'retrying'] } }),
        B2CIntegrationStatus.countDocuments({ consecutiveFailures: { $gt: 0 } }),
      ]);
      result.health = { failedInbound, heldOutbound, failedOutbound, integrationErrors };
    }
    return result;
  }

  async function reports(query, user) {
    const settings = await getSettings();
    const filter = buildListFilter({ from: query.from, to: query.to, category: query.category, region: query.region }, user);
    const tickets = await B2CEscalation.find(filter).select('status category region createdAt resolution.resolvedAt workflow.currentLevel').limit(20_000).lean();
    const at = now().getTime();
    const group = (items, pick) => Object.entries(items.reduce((result, item) => { const key = pick(item) || 'Not set'; result[key] = (result[key] || 0) + 1; return result; }, {})).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    const active = tickets.filter(ticket => ACTIVE_STATUSES.includes(ticket.status));
    const ageDays = ticket => (at - new Date(ticket.createdAt).getTime()) / 86_400_000;
    const ageing = AGE_BUCKETS.map(([name, max], index) => ({ name, value: active.filter(ticket => ageDays(ticket) < max && (index === 0 || ageDays(ticket) >= AGE_BUCKETS[index - 1][1])).length }));
    const resolved = tickets.filter(ticket => ticket.resolution?.resolvedAt);
    const hours = ticket => (new Date(ticket.resolution.resolvedAt) - new Date(ticket.createdAt)) / 3_600_000;
    const stats = items => {
      if (!items.length) return { count: 0, averageHours: null, medianHours: null };
      const sorted = items.map(hours).sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      return { count: sorted.length, averageHours: Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 10) / 10, medianHours: Math.round(median * 10) / 10 };
    };
    const resolutionBy = pick => Object.entries(resolved.reduce((result, ticket) => { const key = pick(ticket) || 'Not set'; (result[key] ||= []).push(ticket); return result; }, {})).map(([name, items]) => ({ name, ...stats(items) }));
    const months = [];
    for (let offset = 11; offset >= 0; offset -= 1) {
      const date = new Date(now().getFullYear(), now().getMonth() - offset, 1);
      const label = date.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
      const inMonth = tickets.filter(ticket => { const created = new Date(ticket.createdAt); return created.getFullYear() === date.getFullYear() && created.getMonth() === date.getMonth(); });
      months.push({ month: label, Service: inMonth.filter(ticket => ticket.category === 'Service').length, Retail: inMonth.filter(ticket => ticket.category === 'Retail').length, Unclassified: inMonth.filter(ticket => ticket.category === UNCLASSIFIED).length });
    }
    return {
      total: tickets.length,
      active: active.length,
      byRegion: group(tickets, ticket => ticket.region),
      byCategory: group(tickets, ticket => ticket.category),
      byStatus: group(tickets, ticket => ticket.status),
      byLevel: group(active.filter(ticket => ticket.workflow?.currentLevel), ticket => levelLabel(settings, ticket.workflow.currentLevel)),
      ageing,
      resolution: { overall: stats(resolved), byCategory: resolutionBy(ticket => ticket.category), byRegion: resolutionBy(ticket => ticket.region) },
      monthly: months,
    };
  }

  // ---- Integration health and recovery (B2C admin) ----------------------------------------
  async function health() {
    const settings = await getSettings();
    const [statuses, inboundCounts, outboundCounts, triage] = await Promise.all([
      B2CIntegrationStatus.find().sort({ key: 1 }).lean(),
      B2CInboundEmail.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      B2COutboundEmail.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      B2CEscalation.countDocuments({ status: STATUS.TRIAGE }),
    ]);
    const byKey = Object.fromEntries(statuses.map(item => [item.key, item]));
    const counts = list => Object.fromEntries(list.map(item => [item._id, item.count]));
    return {
      inboxes: settings.inboxes.map(inbox => ({ key: inbox.key, address: inbox.address, displayName: inbox.displayName, enabled: inbox.enabled, defaultCategory: inbox.defaultCategory, ...emailConnectors.describe(inbox), status: byKey[`email:${inbox.key}`] || null })),
      crm: { provider: crmConnector.provider, mode: crmConnector.isConfigured() ? crmConnector.mode : 'not_configured', configured: crmConnector.isConfigured(), status: byKey.crm || null },
      outbound: byKey.outbound || null,
      scheduler: { pollMinutes: config.pollMinutes, running: scheduler.running, lastRunAt: scheduler.lastRunAt, lastResult: scheduler.lastResult, lastError: scheduler.lastError, status: byKey.scheduler || null },
      queues: { inbound: counts(inboundCounts), outbound: counts(outboundCounts), triage },
      testAdapters: { email: Boolean(emailConnectors.get('test')), crm: crmConnector.mode === 'test' },
    };
  }

  async function listInbound(query) {
    const statuses = ['failed', 'retrying', 'ignored', 'received', 'processing', 'processed'];
    const status = statuses.includes(query.status) ? query.status : null;
    const filter = status ? { status } : { status: { $in: ['failed', 'retrying', 'ignored'] } };
    const items = await B2CInboundEmail.find(filter).select('inboxKey from subject receivedAt status outcome attempts lastError nextAttemptAt ticketId autoGenerated attachments.status attachments.rejectReason attachments.filename').sort({ receivedAt: -1 }).limit(100).populate('ticketId', 'reference').lean();
    return items;
  }

  async function retryInbound(id, user) {
    if (!mongoose.isValidObjectId(id)) throw new B2CError('Email not found', 404);
    const record = await B2CInboundEmail.findById(id);
    if (!record) throw new B2CError('Email not found', 404);
    if (!['failed', 'retrying', 'ignored'].includes(record.status)) throw new B2CError('Only failed or ignored emails can be reprocessed.', 409);
    // Reprocessing an ignored email is an explicit decision that it is not automated.
    const wasIgnored = record.status === 'ignored';
    Object.assign(record, { status: 'received', attempts: 0, nextAttemptAt: null, lockedUntil: null, ...(wasIgnored ? { autoGenerated: null } : {}) });
    await record.save();
    await auditGeneral('inbound_reprocess_requested', user, { ticketId: record.ticketId || null, details: { inboundId: String(record._id), previous: wasIgnored ? 'ignored' : 'failed' }, link: record.ticketId ? `/b2c/tickets/${record.ticketId}` : '/b2c/integrations' });
    await processPendingInbound({ limit: 5 });
    await sendPendingOutbound({ limit: 5 });
    return B2CInboundEmail.findById(id).select('status outcome attempts lastError ticketId').lean();
  }

  async function listOutbound(query) {
    const status = ['held', 'failed', 'retrying', 'queued', 'sent'].includes(query.status) ? query.status : null;
    return B2COutboundEmail.find(status ? { status } : { status: { $in: ['held', 'failed', 'retrying'] } }).select('ticketId kind to status heldReason attempts lastError createdAt templateKey').sort({ createdAt: -1 }).limit(100).populate('ticketId', 'reference').lean();
  }

  async function retryOutbound(id) {
    if (!mongoose.isValidObjectId(id)) throw new B2CError('Email not found', 404);
    const outbound = await B2COutboundEmail.findOneAndUpdate({ _id: id, status: 'failed' }, { $set: { status: 'queued', attempts: 0, nextAttemptAt: now(), lastError: null } }, { new: true });
    if (!outbound) throw new B2CError('Only failed emails can be retried.', 409);
    await sendPendingOutbound({ limit: 5 });
    return B2COutboundEmail.findById(id).select('status attempts lastError sentAt').lean();
  }

  async function attachmentFor(ticketId, downloadKey, user) {
    const ticket = await loadVisibleTicket(ticketId, user);
    const record = await B2CInboundEmail.findOne({ ticketId: ticket._id, 'attachments.storageKey': String(downloadKey) }).select('attachments').lean();
    const attachment = record?.attachments.find(item => item.storageKey === String(downloadKey) && item.status === 'stored');
    if (!attachment) throw new B2CError('Attachment not found', 404);
    await audit(ticket, 'attachment_downloaded', { actor: user, details: { filename: attachment.filename } });
    return { ...attachment, content: await attachmentStore.read(attachment.storageKey) };
  }

  // TEST ADAPTER ONLY: places a message in a test inbox and runs one cycle.
  async function injectTestEmail(input, user) {
    const adapter = emailConnectors.get('test');
    if (!adapter) throw new B2CError('The test email adapter is not available in this environment.', 404);
    const settings = await getSettings();
    const inbox = settings.inboxes.find(item => item.key === input.inboxKey && item.provider === 'test');
    if (!inbox) throw new B2CError('Choose an inbox that uses the test adapter.');
    const from = String(input.from || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) throw new B2CError('Enter a valid sender email address.');
    const subject = String(input.subject || '').slice(0, 500);
    const body = String(input.body || '').slice(0, 50_000);
    if (!subject.trim() && !body.trim()) throw new B2CError('Enter a subject or body.');
    const attachments = (Array.isArray(input.attachments) ? input.attachments : []).slice(0, 3).map(item => ({ filename: String(item.filename || 'attachment'), content: Buffer.from(String(item.contentBase64 || ''), 'base64') }));
    const providerMessageId = adapter.inject(inbox.address, {
      internetMessageId: `<test-${crypto.randomUUID()}@b2c-test.local>`, from: { address: from, name: String(input.fromName || '').slice(0, 120) }, to: [inbox.address],
      subject, text: body, receivedAt: now().toISOString(), headers: {}, attachments,
    });
    await auditGeneral('test_email_injected', user, { details: { inbox: inbox.key }, link: '/b2c/integrations' });
    const result = await runCycle('test-adapter');
    const record = await B2CInboundEmail.findOne({ dedupeKey: `${inbox.key}:${providerMessageId}` }).populate('ticketId', 'reference status').lean();
    return { result, email: record ? { status: record.status, outcome: record.outcome, ticket: record.ticketId, lastError: record.lastError } : null };
  }

  function testOutbox() {
    const adapter = emailConnectors.get('test');
    if (!adapter) throw new B2CError('The test email adapter is not available in this environment.', 404);
    return adapter.sentMessages();
  }

  return {
    getSettings, updateSettings, ingestMessage, pollInbox, processPendingInbound, processInbound, retryCrmLookups, sendPendingOutbound, runCycle,
    performAction, getTicketDetail, listTickets, dashboard, reports, health, listInbound, retryInbound, listOutbound, retryOutbound, attachmentFor,
    injectTestEmail, testOutbox, staffForUser, schedulerStatus: () => ({ ...scheduler }),
  };
}
