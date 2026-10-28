import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { B2C_ADMIN, B2C_ROLES, CATEGORIES, DEFAULT_TEMPLATES, IDENTIFIER_TYPES, STANDARD_PRIORITY, UNCLASSIFIED, defaultSettings } from './b2cDefaults.js';
import { normaliseInboundEmail, ticketReferenceIn } from './emailContent.js';
import { extractIdentifiers } from './identifiers.js';
import { classifyEscalation } from './classifier.js';
import { storeAttachments } from './attachments.js';
import { renderTemplate, templateVars } from './templates.js';
import { maskEmail, redactDetails, safeErrorMessage } from './redact.js';
import { ConnectorError } from './connectors/connectorErrors.js';
import { validateSettingsUpdate } from './settingsValidation.js';
import { computeSlaEscalation, slaTargets } from '../slaEscalation.js';
import { regionKey, serialFromIdentifiers } from './deviceRegion.js';
import { assessCustomerRegion, extractContacts, matchCustomer, normalisePhone, serialForLookup } from './customerMatch.js';
import { REGISTRATION_FIELDS, hashRegistrationToken, isRegistrationToken, newRegistrationToken, resolveRegistration, validateRegistration } from './registration.js';
import { OPEN_REGISTRATION, REGISTRATION_STATUSES } from './b2cModels.js';
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
// deviceDirectory reads the portal's `devices` collection: findBySerial(serial) → device
// records with that serial number, regions() → the regions defined on devices.
// ackSender (connectors/smtpAckSender.js) sends acknowledgements from the separate company
// address when enabled; otherwise the ticket's inbox connector sends them as before.
// customerDirectory reads the portal's `customers` collection: findByEmail, findByPhone
// (digits from normalisePhone) and findBySerial → Customer records. Names are compared
// with the records these return, never searched. create(record) adds the purchase record of
// a customer who completed registration.
const NO_DEVICES = { findBySerial: async () => [], regions: async () => [] };
const NO_CUSTOMERS = { findByEmail: async () => [], findByPhone: async () => [], findBySerial: async () => [], create: async () => { throw new Error('No customer directory is configured.'); } };
export function createB2CService({ models, User, notifyUsers = async () => {}, escalationRules = async () => [], deviceDirectory = NO_DEVICES, customerDirectory = NO_CUSTOMERS, ackSender = null, emailConnectors, crmConnector, attachmentStore, config, logger = console, now = () => new Date() }) {
  const { B2CSettings, B2CInboundEmail, B2CEscalation, B2CAuditEvent, B2COutboundEmail, B2CIntegrationStatus, B2CCounter, B2CRegistrationRequest } = models;
  const registrationConfig = config.registration || { enabled: false };
  const scheduler = { running: false, lastRunAt: null, lastResult: null, lastError: null };

  // ---- Settings ----------------------------------------------------------------
  async function getSettings() {
    let settings = await B2CSettings.findOne({ key: 'default' }).lean();
    // Templates added in a later release join existing settings, unapproved.
    const missing = settings ? DEFAULT_TEMPLATES.filter(template => !settings.templates.some(item => item.key === template.key)) : [];
    for (const template of missing) await B2CSettings.updateOne({ key: 'default', 'templates.key': { $ne: template.key } }, { $push: { templates: template } });
    if (missing.length) settings = await B2CSettings.findOne({ key: 'default' }).lean();
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
    const settings = await getSettings();
    if (update.classificationRules || update.inboxes) await reclassifyTriage(settings);
    return settings;
  }

  // Tickets still waiting in triage are checked again with the saved settings: one without a
  // category is classified with the rules, and one that has a category and a region completes
  // triage by itself. A category an admin chose is never changed.
  async function reclassifyTriage(settings) {
    const waiting = await B2CEscalation.find({ status: STATUS.TRIAGE, 'triage.resolvedAt': null }).limit(200);
    for (const ticket of waiting) {
      const record = ticket.category === UNCLASSIFIED && ticket.classification?.source !== 'manual' ? await B2CInboundEmail.findById(ticket.sourceEmailId).select('subject bodyText').lean() : null;
      if (!record) { await evaluateTriage(ticket, settings); continue; }
      const inbox = settings.inboxes.find(item => item.key === ticket.inboxKey) || { key: ticket.inboxKey };
      const classification = classifyEscalation({ inbox, subject: record.subject, body: record.bodyText }, settings.classificationRules);
      if (classification.category !== UNCLASSIFIED) {
        ticket.category = classification.category;
        ticket.classification = { source: classification.source, matched: classification.matched, note: classification.reason };
        await ticket.save();
        await audit(ticket, 'category_identified', { details: { category: ticket.category, classifiedBy: classification.source } });
      }
      await evaluateTriage(ticket, settings);
    }
  }

  // ---- Shared helpers ------------------------------------------------------------
  // Runs `work(session)` in a transaction where the database supports them (a replica set or
  // sharded cluster); on a standalone server `session` is undefined and callers rely on their
  // writes being safe to repeat.
  let transactionsSupported = null;
  async function withTransaction(work) {
    const connection = B2CRegistrationRequest.db;
    if (transactionsSupported === null) {
      try {
        const hello = await connection.db.admin().command({ hello: 1 });
        transactionsSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
      } catch { transactionsSupported = false; }
    }
    if (!transactionsSupported) return work(undefined);
    const session = await connection.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await work(session); });
      return result;
    } finally { await session.endSession(); }
  }

  async function nextReference() {
    const year = now().getFullYear();
    const counter = await B2CCounter.findOneAndUpdate({ key: `reference-${year}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
    return `${config.referencePrefix}-${year}-${String(counter.seq).padStart(6, '0')}`;
  }

  const auditActor = actor => (actor === SYSTEM ? SYSTEM : { userId: actor.id || actor.userId, name: actor.name, role: actor.b2cRole || actor.role });
  // `alerted` lists the users already sent a specific notification for this event.
  async function audit(ticket, action, { actor = SYSTEM, fromStatus, toStatus, note, details, alerted } = {}) {
    const event = await B2CAuditEvent.create({ ticketId: ticket._id, reference: ticket.reference, action, actor: auditActor(actor), fromStatus, toStatus, note: note ? String(note).slice(0, 5000) : undefined, details: redactDetails(details), at: now() });
    await notifyLog(event, ticket, { alerted });
    return event;
  }
  // Events of a registration request whose ticket does not exist yet. They join the ticket's
  // history when it is created (linkRequestToTicket).
  async function auditRequest(request, action, { actor = SYSTEM, note, details } = {}) {
    const event = await B2CAuditEvent.create({ ticketId: null, registrationId: request._id, action, actor: auditActor(actor), note: note ? String(note).slice(0, 5000) : undefined, details: redactDetails(details), at: now() });
    await notifyLog(event, null, { link: '/b2c/registrations' });
    return event;
  }
  async function auditRequestOnce(request, action, options) {
    if (await B2CAuditEvent.exists({ registrationId: request._id, action })) return null;
    return auditRequest(request, action, options);
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
    region_identified: 'Region identified from customer device', region_not_identified: 'Region not identified', region_set: 'Region set in triage',
    category_identified: 'Category identified from rules', queued_for_triage: 'Queued for triage', triage_completed: 'Triage completed', routed: 'Routed to workflow', acknowledgement_queued: 'Acknowledgement queued', acknowledgement_not_sent: 'No acknowledgement sent',
    email_sent: 'Email sent', email_send_failed: 'Email send failed', email_not_sent: 'Customer email not sent (receive-only inbox)', customer_replied: 'Customer replied', sla_escalation: 'SLA escalation', claim: 'Took ownership', assign: 'Engineer assigned', accept: 'Engineer accepted',
    start: 'Work started', reroute: 'Rerouted', set_path: 'Workflow path changed', request_clarification: 'Clarification requested',
    propose_resolution: 'Repair completion submitted', approve_resolution: 'Resolution approved', reject_resolution: 'Resolution returned for rework',
    close: 'Closed', close_unresolved: 'Closed without resolution', reopen: 'Reopened', add_note: 'Internal note added', attachment_downloaded: 'Attachment downloaded',
    settings_updated: 'B2C settings updated', test_email_injected: 'Test email injected', inbound_reprocess_requested: 'Email reprocessing requested',
    imap_connection_tested: 'IMAP connection tested',
    registration_requested: 'Customer registration requested', registration_not_requested: 'Customer registration not requested', registration_resent: 'Registration link sent again',
    registration_opened: 'Registration link opened', registration_completed: 'Customer registration completed', registration_needs_review: 'Customer registration needs review',
    registration_expired: 'Registration link expired', registration_cancelled: 'Customer registration cancelled', registration_withdrawn: 'Registration link withdrawn',
    registration_email_failed: 'Registration email failed', ticket_created_without_registration: 'Ticket created without customer registration',
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
    // A reply to a registration email whose ticket does not exist yet joins that request.
    const waiting = await findThreadRegistration(record);
    if (waiting) {
      await B2CRegistrationRequest.updateOne({ _id: waiting._id }, { $addToSet: { relatedEmailIds: record._id } });
      return finish('processed', 'appended_to_registration');
    }
    // A sender who must register first gets a registration request, not a ticket.
    const held = await holdForRegistration(record, settings);
    if (held) return finish('processed', held.outcome, held.ticketId);
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

  // The ticket for an email, with its reference number: one per email (unique sourceEmailId),
  // so a retry finds the ticket a partial run created. The email is linked to it before
  // anything else happens, so a retry resumes this ticket.
  async function createTicketRecord(record, settings, { via = 'email' } = {}) {
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
          // The region comes only from the matched customer's registered device (or triage),
          // never from the inbox, the customer's address or an unverified serial number.
          identifiers, customer: { email: record.from.address, name: record.from.name || '' }, customerMatch: { status: 'pending' }, region: '', regionAssignment: { status: 'pending' },
          status: STATUS.TRIAGE, triage: { reasons: [] }, workflow: { path: [], currentLevel: null }, crm: { status: 'pending' },
          ...slaTargets(STANDARD_PRIORITY, now()),
          lastCustomerMessageAt: record.receivedAt, lastActivityAt: now(),
        });
      } catch (error) {
        if (error?.code !== 11000 || !error.keyPattern?.sourceEmailId) throw error;
        ticket = await B2CEscalation.findOne({ sourceEmailId: record._id });
      }
    }
    await B2CInboundEmail.updateOne({ _id: record._id }, { $set: { ticketId: ticket._id } });
    record.ticketId = ticket._id;
    await auditOnce(ticket, 'created_from_email', { toStatus: STATUS.TRIAGE, details: { inbox: ticket.inboxKey, identifierTypes: ticket.identifiers.map(item => item.type), category: ticket.category, classifiedBy: ticket.classification?.source || 'none', ...(via !== 'email' ? { after: via } : {}) } });
    return ticket;
  }

  // The steps after a ticket is created from an email whose customer is matched from the email.
  async function continueTicketFromEmail(ticket, settings, record) {
    await assessRegion(ticket, settings, { record });
    if (ticket.crm.status === 'pending') await enrichFromCrm(ticket);
    if (ticket.status === STATUS.TRIAGE && !ticket.triage?.resolvedAt) await evaluateTriage(ticket, settings);
    // While a registration for an existing ticket is open the acknowledgement waits for the customer to be verified.
    if (!awaitingRegistration(ticket)) await queueAcknowledgement(ticket);
    return ticket;
  }

  async function createTicketFromEmail(record, settings) {
    const ticket = await createTicketRecord(record, settings);
    return continueTicketFromEmail(ticket, settings, record);
  }

  // ---- Customer and device region -----------------------------------------------------
  // The email is matched to a registered customer (`customers`) only when two independent
  // details fit the same record: two of name, email address and phone number, or the
  // email's serial number plus one of them (customerMatch.js). A serial number in the
  // email that is on a device record gives the ticket that device's region, unless the
  // details conflict or are ambiguous, or the identified customer does not own it. Without
  // one, the matched customer's only registered device gives the region. Whether the
  // sender owns the serial number is recorded (`ownerCheck`); only a verified one is used
  // for the CRM or quoted in the acknowledgement. Decided only while the ticket waits for routing: once it is routed, or an admin has
  // chosen the region, reprocessing the email or a CRM retry never changes the region or
  // the assignment. A failing database lookup throws, so the email is retried rather
  // than routed without a region.
  const regionOpen = ticket => ticket.status === STATUS.TRIAGE && !ticket.triage?.resolvedAt && ticket.regionAssignment?.status !== 'manual';
  // Which registered customer and device an email identifies. `source` is the inbound email;
  // `fallback` the ticket's customer when the email record is gone.
  async function matchEmail({ source, identifiers, settings, fallback = {} }) {
    const contacts = extractContacts({ from: source?.from?.address || fallback.email, fromName: source?.from?.name ?? fallback.name, subject: source?.subject, body: source?.bodyText, ignore: settings.inboxes.map(inbox => inbox.address) });
    const emails = [contacts.senderEmail, ...contacts.emails].filter(Boolean);
    const candidates = [];
    for (const email of emails) candidates.push(...await customerDirectory.findByEmail(email));
    for (const phone of contacts.phones) candidates.push(...await customerDirectory.findByPhone(phone));
    const { serial: emailSerial } = serialFromIdentifiers(identifiers);
    // The serial number's registered owners: corroborating evidence, and the owner check.
    const serialOwners = emailSerial ? await customerDirectory.findBySerial(emailSerial) : [];
    const match = matchCustomer({ candidates, names: contacts.names, emails, phones: contacts.phones, serial: emailSerial, serialOwners });
    const lookupSerial = serialForLookup({ match, identifiers });
    const devices = lookupSerial ? await deviceDirectory.findBySerial(lookupSerial) : [];
    return { match, assessment: assessCustomerRegion({ match, identifiers, serialOwners, devices }) };
  }

  async function assessRegion(ticket, settings, { actor = SYSTEM, record = null } = {}) {
    if (!regionOpen(ticket)) return;
    // A customer verified through registration is not matched from the email again.
    if (ticket.customerMatch?.method === 'registration') return;
    // Copied: a Mongoose nested path reads through to the current values.
    const { status, region, reason } = ticket.regionAssignment || {};
    const previousMatch = ticket.customerMatch?.status;
    const source = record || await B2CInboundEmail.findById(ticket.sourceEmailId).select('from subject bodyText').lean();
    const { match, assessment } = await matchEmail({ source, identifiers: ticket.identifiers, settings, fallback: ticket.customer || {} });

    ticket.customerMatch = { status: match.status, method: match.method, matchedBy: match.matchedBy, customerIds: match.records.map(item => item.customerId).filter(Number.isInteger), name: match.records[0]?.name, email: match.records[0]?.email, evaluatedAt: now() };
    ticket.regionAssignment = { ...assessment, evaluatedAt: now(), decidedBy: undefined, note: undefined };
    ticket.region = assessment.status === 'automatic' ? assessment.region : '';
    await ticket.save();
    const same = (a, b) => (a ?? null) === (b ?? null);
    if (same(previousMatch, match.status) && same(status, assessment.status) && same(region, assessment.region) && same(reason, assessment.reason)) return;
    // Which details matched, the device record and the outcome; never the detail values.
    const resolved = assessment.status === 'automatic';
    const matching = { customerMatch: match.method || match.status, matchedBy: match.matchedBy, deviceId: assessment.deviceId ? String(assessment.deviceId) : null };
    await audit(ticket, resolved ? 'region_identified' : 'region_not_identified', { actor, details: resolved ? { region: assessment.region, source: assessment.source, ...matching, ownerCheck: assessment.ownerCheck } : { reason: assessment.reason, ...matching, customerMatch: match.status } });
  }

  // The serial number registered to the matched customer, or null: never one the email
  // quoted that belongs to someone else, to nobody, or to an unmatched sender.
  function verifiedSerial(ticket) {
    const { serialNumber, ownerCheck } = ticket.regionAssignment || {};
    return ticket.customerMatch?.status === 'matched' && ownerCheck === 'verified' && serialNumber ? serialNumber : null;
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
    // Only a serial number registered to the matched customer is looked up, so an email
    // quoting someone else's serial number never brings their CRM record onto the ticket.
    const serial = verifiedSerial(ticket);
    const verifiedSerials = serial ? [serial] : [];
    let timer;
    try {
      const lookup = crmConnector.lookup({ caseIds: of('caseId'), serialNumbers: verifiedSerials, email: ticket.customer?.email });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('CRM lookup timed out'), { retryable: true })), config.crmTimeoutMs); });
      const { matches = [] } = await Promise.race([lookup, timeout]);
      const status = matches.length === 1 ? 'matched' : matches.length ? 'multiple_matches' : 'no_match';
      if (status === 'matched') {
        const [match] = matches;
        // The customer's own region is not used: the ticket's region comes from the device record.
        ticket.customer = { email: ticket.customer.email, name: match.customer?.name || ticket.customer.name, phone: match.customer?.phone || '', crmCustomerId: match.customer?.crmCustomerId || '' };
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
    // No region from a device record; "no serial number" is already covered
    // when the email had no identifier at all.
    const region = ticket.regionAssignment;
    if (region?.status === 'unresolved' && region.reason && !(region.reason === 'serial_number_missing' && reasons.includes('missing_identifier'))) reasons.push(region.reason);
    const registrationStatus = ticket.registration?.status;
    if (awaitingRegistration(ticket)) reasons.push('customer_registration_pending');
    else if (registrationStatus === 'manual_review') reasons.push('customer_registration_review');
    else if (registrationStatus === 'expired') reasons.push('customer_registration_expired');
    return reasons;
  }

  async function evaluateTriage(ticket, settings) {
    const found = triageReasons(ticket);
    // Routing needs only the category and the region. Once both are known the ticket
    // completes triage by itself; CRM findings and identifier gaps are recorded, not blocking.
    const ready = ticket.category !== UNCLASSIFIED && Boolean(ticket.region);
    const reasons = ready ? [] : found;
    // A known region that nobody holds the first level for is a configuration gap: it is
    // flagged for an admin instead of being left in a queue nobody watches.
    const firstLevel = defaultPath(settings)[0];
    if (!reasons.length && firstLevel && !(await levelStaff(firstLevel, ticket)).length) reasons.push('no_regional_assignee');
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
    await audit(ticket, 'triage_completed', { fromStatus: ticket.status, details: { automatic: true, category: ticket.category, region: ticket.region, regionStatus: ticket.regionAssignment?.status || null, overriddenReasons: found } });
    await routeToWorkflow(ticket, settings, SYSTEM);
    return true;
  }

  // `chosen` is an assignee picked in triage (already checked for the level and region).
  async function routeToWorkflow(ticket, settings, actor, chosen = null) {
    const path = defaultPath(settings);
    if (!path.length) {
      ticket.triage = { reasons: ['no_workflow_path'] };
      await ticket.save();
      await audit(ticket, 'queued_for_triage', { actor, details: { reasons: ['no_workflow_path'] } });
      return;
    }
    const fromStatus = ticket.status;
    const assignee = chosen || await autoAssignee(path[0], ticket);
    ticket.workflow = { path, currentLevel: path[0], assignee, assignedAt: assignee ? now() : null };
    ticket.status = statusForAssignment(assignee);
    ticket.triage = { reasons: [], resolvedAt: now(), resolvedBy: actor.name };
    if (assignee) addParticipant(ticket, assignee.userId);
    ticket.lastActivityAt = now();
    await ticket.save();
    const alerted = await notifyLevel(ticket, settings, 'New escalation');
    // 'manual': picked in triage; 'automatic': the only eligible person; 'queue': the level's regional queue.
    const assignment = chosen ? 'manual' : assignee ? 'automatic' : 'queue';
    await audit(ticket, 'routed', { actor, fromStatus, toStatus: ticket.status, details: { level: levelLabel(settings, path[0]), assignee: assignee?.name || null, assignment, path: path.map(key => levelLabel(settings, key)), region: ticket.region || null, regionSource: ticket.regionAssignment?.source || null }, alerted });
    if (assignee) await queueAcknowledgement(ticket, { onAssignment: true });
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
  async function queueOutbound(ticket, { kind, templateKey, vars = {}, dedupeKey, createdBy, to = ticket.customer.email, via = 'inbox', from, replyTo, registrationId }) {
    try {
      return await B2COutboundEmail.create({ dedupeKey, ticketId: ticket._id, inboxKey: ticket.inboxKey, kind, templateKey, vars, via, from, replyTo, to, registrationId, status: 'queued', nextAttemptAt: now(), createdBy });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      return B2COutboundEmail.findOne({ dedupeKey });
    }
  }

  // Who the acknowledgement goes to when the company sender is used: always the address the
  // email came from, never an address from the customer records. A matched customer's email
  // is acknowledged; an unmatched one only under policy 'sender'.
  const VALID_EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
  function ackRecipient(ticket) {
    const matched = ticket.customerMatch?.status === 'matched';
    if (!matched && config.ack?.unmatchedPolicy !== 'sender') return { reason: 'customer_not_verified' };
    const address = String(ticket.customer?.email || '').trim().toLowerCase();
    return VALID_EMAIL.test(address) && address.length <= 254 ? { to: address } : { reason: 'invalid_recipient' };
  }

  // What the acknowledgement may quote. The registered customer's name and serial number go
  // only to their own registered address; a relative or dealer writing for them sees only what
  // their email gave (a verified serial number they quoted) and their own display name, taken
  // from the email because a CRM match replaces the ticket's customer name.
  async function ackVars(ticket, to) {
    const match = ticket.customerMatch;
    const ownAddress = match?.status === 'matched' && String(match.email || '').trim().toLowerCase() === to;
    const serial = verifiedSerial(ticket);
    const quoted = serial && ticket.regionAssignment?.emailSerialNumber === serial;
    const senderName = ownAddress ? null : (await B2CInboundEmail.findById(ticket.sourceEmailId).select('from.name').lean())?.from?.name;
    const customerName = ownAddress ? match.name : senderName || 'Customer';
    return { companyName: config.ack.companyName, serialNumber: serial && (ownAddress || quoted) ? serial : '', ...(customerName ? { customerName } : {}) };
  }

  // Exactly one acknowledgement is sent per ticket: the dedupe key `ack:<ticket id>` is unique,
  // and a ticket that already has one (or was decided not to get one) is left alone on
  // reprocessing. `onAssignment`: an engineer was just assigned, and every assigned ticket must
  // be acknowledged, so one that was skipped (receive-only inbox, customer not verified,
  // invalid address) is tried again through the company sender: the sender may have been
  // turned on, or triage may have identified the customer, since. The retry has its own
  // dedupe key, so it never reuses the skipped message and is queued at most once.
  async function queueAcknowledgement(ticket, { onAssignment = false } = {}) {
    const previous = ticket.acknowledgement?.status ? { status: ticket.acknowledgement.status, reason: ticket.acknowledgement.reason || null, outboundId: ticket.acknowledgement.outboundId || null } : null;
    const retry = onAssignment && ackSender?.enabled && previous?.status === 'skipped';
    if (!retry && (previous?.outboundId || previous?.status === 'skipped')) return;
    const dedupeKey = retry ? `ack:${ticket._id}:assigned` : `ack:${ticket._id}`;
    let outbound;
    if (ackSender?.enabled) {
      const recipient = ackRecipient(ticket);
      if (recipient.reason) {
        if (retry && previous.reason === recipient.reason) return;
        ticket.acknowledgement = { status: 'skipped', reason: recipient.reason, outboundId: previous?.outboundId || undefined };
        await ticket.save();
        if (retry) await audit(ticket, 'acknowledgement_not_sent', { details: { reason: recipient.reason, onAssignment: true } });
        else await auditOnce(ticket, 'acknowledgement_not_sent', { details: { reason: recipient.reason } });
        return;
      }
      outbound = await queueOutbound(ticket, { kind: 'acknowledgement', templateKey: 'acknowledgement', dedupeKey, via: 'company_sender', to: recipient.to, from: ackSender.fromEmail, replyTo: ticket.inboxAddress, vars: await ackVars(ticket, recipient.to) });
    } else {
      outbound = await queueOutbound(ticket, { kind: 'acknowledgement', templateKey: 'acknowledgement', dedupeKey });
    }
    ticket.acknowledgement = { status: 'queued', outboundId: outbound._id };
    await ticket.save();
    if (retry) await audit(ticket, 'acknowledgement_queued', { details: { via: outbound.via, onAssignment: true, previousReason: previous.reason || 'receive_only_inbox' } });
    else await auditOnce(ticket, 'acknowledgement_queued', { details: { via: outbound.via } });
  }

  // Only the ticket's current acknowledgement message updates it, not an earlier skipped one.
  async function syncAcknowledgement(outbound, status, sentAt, reason) {
    if (outbound.kind !== 'acknowledgement') return;
    await B2CEscalation.updateOne({ _id: outbound.ticketId, 'acknowledgement.outboundId': outbound._id }, { $set: { 'acknowledgement.status': status, ...(sentAt ? { 'acknowledgement.sentAt': sentAt } : {}), ...(reason ? { 'acknowledgement.reason': reason } : {}) } });
  }
  async function syncOutbound(outbound, status, sentAt, reason) {
    await syncAcknowledgement(outbound, status, sentAt, reason);
    if (outbound.kind === 'registration') await syncRegistrationEmail(outbound, status, sentAt, reason);
  }

  // What is sent and what is stored. A registration email gets a new link as it is sent; the
  // stored copy (and the ticket's conversation) shows a placeholder, never the token.
  const LINK_PLACEHOLDER = '[secure registration link — sent to the customer, not stored]';
  async function renderForSending(outbound, template, ticket) {
    const stored = renderTemplate(template, templateVars(ticket, outbound.vars));
    if (outbound.kind !== 'registration') return { rendered: stored, stored };
    const link = await issueRegistrationLink(outbound);
    return { rendered: renderTemplate(template, templateVars(ticket, { ...outbound.vars, ...link })), stored };
  }

  // ---- Customer registration --------------------------------------------------------------
  // A sender who cannot be identified (no registered customer matches the email, or fewer
  // than two details do) and whose email gives no region from a device record is emailed a
  // single-use link to register, and no ticket is created: the email waits in a registration
  // request (one per email, so polling and reprocessing never add another, and no reference
  // number is used). Details that conflict or fit several customers go to triage as before.
  // The submission is checked against the device and customer records (registration.js) and
  // saved; only then is the ticket created from the original email, given the device's region,
  // routed and acknowledged. A submission that cannot be verified, an expired link or an email
  // that could not be sent waits for a B2C admin, who can send the link again or create the
  // ticket without registration. A request made for an existing ticket (by staff, or before
  // tickets waited for registration) continues that ticket instead.
  const REGISTRATION_TRIGGERS = ['not_found', 'insufficient'];
  const awaitingRegistration = ticket => [...OPEN_REGISTRATION, 'processing'].includes(ticket.registration?.status);
  const REGISTRATION_UNAVAILABLE = {
    portal_url_not_configured: 'B2C_REGISTRATION_PORTAL_URL is not set (an HTTPS address is required in production).',
    no_outbound_sender: 'No email can be sent for this escalation: turn on the company sender (B2C_ACK_EMAIL_ENABLED) or use an inbox that can send.',
    invalid_recipient: 'The address the email came from is not a valid email address.',
    recipient_daily_limit: 'This address has already been sent the most registration emails allowed today.',
  };
  const setRegistration = (ticket, fields) => { ticket.registration = { ...(ticket.toObject().registration || {}), ...fields }; };
  const triageOpen = ticket => ticket.status === STATUS.TRIAGE && !ticket.triage?.resolvedAt;
  const formatExpiry = date => `${date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`;
  const validRecipient = address => VALID_EMAIL.test(address) && address.length <= 254;
  const issueSummaryOf = record => String(record.subject || '').replace(/\s+/g, ' ').trim().slice(0, 250) || String(record.bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  // How a registration email can be sent: from the company address, or by the email's own inbox.
  function registrationChannel(inboxKey, settings) {
    if (!registrationConfig.portalUrl) return { reason: 'portal_url_not_configured' };
    if (ackSender?.enabled) return { via: 'company_sender', from: ackSender.fromEmail };
    const inbox = settings.inboxes.find(item => item.key === inboxKey);
    return inbox && emailConnectors.canSend(inbox) ? { via: 'inbox' } : { reason: 'no_outbound_sender' };
  }
  // The inbox the request's email came to; requests made before it was stored take their ticket's.
  async function requestInbox(request) {
    if (request.inboxKey) return { inboxKey: request.inboxKey, inboxAddress: request.inboxAddress };
    const ticket = request.ticketId ? await B2CEscalation.findById(request.ticketId).select('inboxKey inboxAddress').lean() : null;
    return { inboxKey: ticket?.inboxKey, inboxAddress: ticket?.inboxAddress };
  }

  // Queues the request's next email. Conditional on the send count read, so two resends at
  // once queue one email.
  async function queueRegistrationEmail(request, channel, actor = SYSTEM) {
    const sequence = (request.sendCount || 0) + 1;
    const { inboxKey, inboxAddress } = await requestInbox(request);
    const outbound = await queueOutbound({ _id: request.ticketId || null, inboxKey }, {
      kind: 'registration', templateKey: 'registration_request', dedupeKey: `registration:${request._id}:${sequence}`, via: channel.via, from: channel.from,
      replyTo: channel.via === 'company_sender' ? inboxAddress : undefined, to: request.recipient, registrationId: request._id,
      vars: { companyName: config.ack?.companyName || 'iPlanet', registrationLink: LINK_PLACEHOLDER, linkExpiry: `${registrationConfig.ttlHours} hours after this email was sent` },
      createdBy: actor === SYSTEM ? undefined : person(actor),
    });
    // The earlier link stops working now; the new email carries its own, with a new expiry. A
    // submission made with the new link is continued afresh, even after an earlier review.
    const result = await B2CRegistrationRequest.updateOne({ _id: request._id, sendCount: request.sendCount || 0 }, { $set: { status: 'email_pending', reason: null, outboundId: outbound._id, lastQueuedAt: now(), failedAttempts: 0, expiresAt: null, resumedAt: null, resumingUntil: null }, $unset: { tokenHash: '' }, $inc: { sendCount: 1 } });
    if (result.modifiedCount !== 1) throw new B2CError('The registration link was sent again by someone else just now.', 409);
    return sequence;
  }

  // The match status that requires this email's sender to register before a ticket is created
  // ('not_found', 'insufficient'), or null: a customer was identified, the details conflict or
  // fit several customers, or a device record gives the email a region.
  async function registrationTrigger(record, settings) {
    const identifiers = extractIdentifiers({ subject: record.subject, body: record.bodyText }, settings.identifierRules);
    const { match, assessment } = await matchEmail({ source: record, identifiers, settings });
    return REGISTRATION_TRIGGERS.includes(match.status) && assessment.status !== 'automatic' ? match.status : null;
  }

  // Run before a ticket is created from an email. Returns how the email was handled
  // ({ outcome, ticketId }), or null when the ticket is to be created now. An email that already
  // has a ticket (created before tickets waited for registration) continues as it is.
  async function holdForRegistration(record, settings) {
    let request = await B2CRegistrationRequest.findOne({ sourceEmailId: record._id });
    if (!request) {
      if (!registrationConfig.enabled || await B2CEscalation.exists({ sourceEmailId: record._id })) return null;
      const trigger = await registrationTrigger(record, settings);
      if (!trigger) return null;
      request = await openRequestForEmail(record, settings, trigger);
    } else if (!request.ticketId && request.status === 'email_pending' && !request.sendCount) {
      // A run that stopped after creating the request: its email is queued now.
      await queueFirstRegistrationEmail(request, settings);
    }
    if (request.ticketId) return null;
    if (request.status === 'completed') {
      const ticket = await resumeTicketAfterRegistration(request._id, settings);
      if (ticket) return { outcome: 'ticket_created', ticketId: ticket._id };
    }
    return { outcome: 'awaiting_registration' };
  }

  // The registration request for an email that has no ticket, and its first email. When no
  // email can be sent the request is kept as 'required' with the reason, for an admin.
  async function openRequestForEmail(record, settings, trigger) {
    const recipient = String(record.from?.address || '').trim().toLowerCase();
    const channel = registrationChannel(record.inboxKey, settings);
    let reason = channel.reason || (validRecipient(recipient) ? null : 'invalid_recipient');
    if (!reason) {
      const recent = await B2CRegistrationRequest.countDocuments({ recipient, sourceEmailId: { $ne: record._id }, createdAt: { $gte: new Date(now().getTime() - 86_400_000) } });
      if (recent >= registrationConfig.maxPerRecipientPerDay) reason = 'recipient_daily_limit';
    }
    let request;
    try {
      request = await B2CRegistrationRequest.create({
        sourceEmailId: record._id, internetMessageId: record.internetMessageId, inboxKey: record.inboxKey, inboxAddress: record.inboxAddress,
        subject: record.subject, issueSummary: issueSummaryOf(record), trigger, recipient, status: reason ? 'required' : 'email_pending', reason, createdAt: now(),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // Created by another run, which queues its email (or a retry of this email does).
      return B2CRegistrationRequest.findOne({ sourceEmailId: record._id });
    }
    if (reason) {
      await auditRequestOnce(request, 'registration_not_requested', { details: { trigger, reason } });
      return request;
    }
    await queueFirstRegistrationEmail(request, settings, channel);
    return request;
  }

  async function queueFirstRegistrationEmail(request, settings, channel = null) {
    const route = channel || registrationChannel((await requestInbox(request)).inboxKey, settings);
    if (route.reason) {
      await B2CRegistrationRequest.updateOne({ _id: request._id, sendCount: 0 }, { $set: { status: 'required', reason: route.reason } });
      await auditRequestOnce(request, 'registration_not_requested', { details: { trigger: request.trigger, reason: route.reason } });
      return;
    }
    // Lost to another run that queued it.
    try { await queueRegistrationEmail(request, route); } catch (error) { if (error instanceof B2CError) return; throw error; }
    await auditRequestOnce(request, 'registration_requested', { details: { trigger: request.trigger, via: route.via, ticketCreated: false } });
  }

  // Staff ask an existing ticket's customer to register: the request continues that ticket.
  async function requestRegistration(ticket, settings, { actor = SYSTEM, manual = false } = {}) {
    const recipient = String(ticket.customer?.email || '').trim().toLowerCase();
    const channel = registrationChannel(ticket.inboxKey, settings);
    let reason = channel.reason || (validRecipient(recipient) ? null : 'invalid_recipient');
    if (!reason && !manual) {
      const recent = await B2CRegistrationRequest.countDocuments({ recipient, ticketId: { $ne: ticket._id }, createdAt: { $gte: new Date(now().getTime() - 86_400_000) } });
      if (recent >= registrationConfig.maxPerRecipientPerDay) reason = 'recipient_daily_limit';
    }
    if (reason) {
      setRegistration(ticket, { status: 'not_requested', reason, requestedAt: now() });
      await ticket.save();
      if (manual) throw new B2CError(REGISTRATION_UNAVAILABLE[reason] || 'The registration link cannot be sent.', 409);
      await auditOnce(ticket, 'registration_not_requested', { details: { reason } });
      return null;
    }
    let request;
    let resumed = false;
    try {
      request = await B2CRegistrationRequest.create({
        ticketId: ticket._id, reference: ticket.reference, sourceEmailId: ticket.sourceEmailId, inboxKey: ticket.inboxKey, inboxAddress: ticket.inboxAddress,
        subject: ticket.subject, issueSummary: issueSummaryOf({ subject: ticket.subject, bodyText: ticket.summary }), trigger: ticket.customerMatch?.status, recipient, status: 'email_pending', createdAt: now(),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // A retry after a partial run: the request (and maybe its email) already exists.
      request = await B2CRegistrationRequest.findOne({ $or: [{ ticketId: ticket._id }, ...(ticket.sourceEmailId ? [{ sourceEmailId: ticket.sourceEmailId }] : [])] });
      resumed = true;
    }
    if (!resumed || !request.sendCount) await queueRegistrationEmail(request, channel, actor);
    setRegistration(ticket, { status: 'email_pending', requestId: request._id, reason: null, requestedAt: request.createdAt || now() });
    await ticket.save();
    await auditOnce(ticket, 'registration_requested', { actor, details: { trigger: request.trigger, via: channel.via, manual } });
    return request;
  }

  // Sends a new link for an existing request (staff, or the customer renewing an expired link).
  async function resendRegistration(request, { actor = SYSTEM, settings, trigger }) {
    const ticket = request.ticketId ? await B2CEscalation.findById(request.ticketId) : null;
    const closed = request.ticketId ? !ticket || !triageOpen(ticket) : request.status === 'cancelled';
    if (closed) throw new B2CError('This request is no longer waiting for the customer to register.', 409);
    if (['completed', 'processing'].includes(request.status)) throw new B2CError('The customer has already submitted the registration form.', 409);
    if ((request.sendCount || 0) >= registrationConfig.maxSends) throw new B2CError(`The registration link has already been sent ${request.sendCount} times, the most allowed.`, 429);
    const waitMs = registrationConfig.resendMinutes * MINUTE - (now().getTime() - new Date(request.lastQueuedAt || 0).getTime());
    if (waitMs > 0) throw new B2CError(`The registration link was sent recently. Try again in ${Math.ceil(waitMs / MINUTE)} minute(s).`, 429);
    const channel = registrationChannel((await requestInbox(request)).inboxKey, settings);
    if (channel.reason) throw new B2CError(REGISTRATION_UNAVAILABLE[channel.reason], 409);
    if (!validRecipient(request.recipient)) throw new B2CError(REGISTRATION_UNAVAILABLE.invalid_recipient, 409);
    const sequence = await queueRegistrationEmail(request, channel, actor);
    if (!ticket) {
      await auditRequest(request, 'registration_resent', { actor, details: { sendNumber: sequence, trigger } });
      return sequence;
    }
    setRegistration(ticket, { status: 'email_pending', reason: null, requestId: request._id });
    await ticket.save();
    await audit(ticket, 'registration_resent', { actor, details: { sendNumber: sequence, trigger } });
    if (triageOpen(ticket)) await evaluateTriage(ticket, settings);
    return sequence;
  }

  // A new token for every send attempt; the latest email's link replaces earlier ones.
  async function issueRegistrationLink(outbound) {
    if (!registrationConfig.portalUrl) throw Object.assign(new Error('B2C_REGISTRATION_PORTAL_URL is not set.'), { retryable: false });
    const token = newRegistrationToken();
    const expiresAt = new Date(now().getTime() + registrationConfig.ttlHours * 3_600_000);
    const request = await B2CRegistrationRequest.findOneAndUpdate({ _id: outbound.registrationId, outboundId: outbound._id, status: { $in: OPEN_REGISTRATION } }, { $set: { tokenHash: hashRegistrationToken(token), tokenIssuedAt: now(), expiresAt } }, { new: true });
    if (!request) throw Object.assign(new Error('The registration request is no longer open, or a newer link was requested.'), { retryable: false });
    return { registrationLink: `${registrationConfig.portalUrl}/b2c/customer-registration/${token}`, linkExpiry: formatExpiry(expiresAt) };
  }

  // Only the request's latest email changes its status. 'Sent' is the mail server accepting it.
  // The registration email's status is the request's; a ticket's status is never changed by it.
  async function syncRegistrationEmail(outbound, status, sentAt, reason) {
    const next = { sent: 'email_sent', failed: 'email_failed', skipped: 'required' }[status];
    if (!next) return;
    if (sentAt) await B2CRegistrationRequest.updateOne({ _id: outbound.registrationId, outboundId: outbound._id }, { $set: { lastSentAt: sentAt } });
    const from = status === 'sent' ? ['email_pending', 'email_failed'] : ['email_pending'];
    const updated = await B2CRegistrationRequest.findOneAndUpdate({ _id: outbound.registrationId, outboundId: outbound._id, status: { $in: from } }, { $set: { status: next, ...(reason ? { reason } : {}) } }, { new: true });
    if (!updated) return;
    if (!updated.ticketId) {
      // No ticket is created because the email failed: the request waits for a resend.
      if (next !== 'email_sent') await auditRequest(updated, next === 'email_failed' ? 'registration_email_failed' : 'registration_not_requested', { details: { reason: reason || null } });
      return;
    }
    const ticket = await B2CEscalation.findOne({ _id: updated.ticketId, 'registration.requestId': updated._id });
    if (!ticket) return;
    setRegistration(ticket, { status: next, ...(reason ? { reason } : {}) });
    await ticket.save();
    // A link that could not be sent is flagged for an admin.
    if (next !== 'email_sent' && triageOpen(ticket)) await evaluateTriage(ticket, await getSettings());
  }

  const linkError = (status, code, message, extra = {}) => Object.assign(new B2CError(message, status), { code, ...extra });
  const invalidLink = () => linkError(404, 'invalid', 'This registration link is not valid. Use the link in the most recent registration email from our support team.');
  async function findRegistration(token) {
    if (!registrationConfig.enabled || !isRegistrationToken(token)) throw invalidLink();
    const request = await B2CRegistrationRequest.findOne({ tokenHash: hashRegistrationToken(token) });
    if (!request) throw invalidLink();
    if (OPEN_REGISTRATION.includes(request.status) && request.expiresAt && request.expiresAt <= now()) {
      await expireRegistration(request);
      return B2CRegistrationRequest.findById(request._id);
    }
    return request;
  }
  // Every check is made here; the page only shows what the server answers.
  function assertUsable(request) {
    if (['completed', 'manual_review'].includes(request.status)) throw linkError(410, 'used', 'This registration link has already been used. Our support team is processing your details.');
    if (request.status === 'processing' && request.lockedUntil > now()) throw linkError(409, 'processing', 'Your details are being processed. Please wait a moment and refresh the page.');
    if (request.status === 'expired') throw linkError(410, 'expired', 'This registration link has expired.', { canRenew: (request.sendCount || 0) < registrationConfig.maxSends });
    if (!OPEN_REGISTRATION.includes(request.status) && request.status !== 'processing') throw linkError(410, 'closed', 'This registration is no longer needed. Our support team is handling your request.');
    if (!request.expiresAt) throw invalidLink();
  }

  // The link was opened: what the form needs, and nothing about the customer.
  async function openRegistration(token) {
    const request = await findRegistration(token);
    assertUsable(request);
    const opened = await B2CRegistrationRequest.findOneAndUpdate({ _id: request._id, status: { $in: ['email_pending', 'email_sent', 'email_failed'] } }, { $set: { status: 'in_progress', openedAt: request.openedAt || now() } }, { new: true });
    if (opened?.ticketId) {
      const ticket = await B2CEscalation.findOne({ _id: opened.ticketId, 'registration.requestId': opened._id });
      if (ticket) {
        setRegistration(ticket, { status: 'in_progress' });
        await ticket.save();
        await auditOnce(ticket, 'registration_opened', {});
      }
    } else if (opened) await auditRequestOnce(opened, 'registration_opened', {});
    return {
      state: 'valid', reference: request.reference || null, expiresAt: request.expiresAt, companyName: config.ack?.companyName || 'iPlanet',
      regions: await deviceDirectory.regions(),
      fields: Object.entries(REGISTRATION_FIELDS).map(([key, rule]) => ({ key, label: rule.label, required: rule.required, maxLength: rule.max })),
    };
  }

  // The form was submitted. The token, the request and the ticket come only from the stored
  // request: nothing in the submission can choose them. The answer is the same whether or not
  // the details were verified, so the form cannot be used to test what is on record; the
  // ticket number reaches the customer in the acknowledgement.
  async function submitRegistration(token, input) {
    const request = await findRegistration(token);
    assertUsable(request);
    const settings = await getSettings();
    const { values, errors } = validateRegistration(input, { regions: await deviceDirectory.regions(), now: now() });
    if (errors) {
      const counted = await B2CRegistrationRequest.findOneAndUpdate({ _id: request._id, status: { $in: OPEN_REGISTRATION } }, { $inc: { failedAttempts: 1 } }, { new: true });
      if (counted && counted.failedAttempts >= registrationConfig.maxSubmitAttempts) {
        await withdrawRegistration(counted, 'too_many_failed_attempts', settings);
        throw linkError(410, 'used', 'This registration link can no longer be used. Our support team will contact you.');
      }
      throw linkError(422, 'validation', 'Some details need correcting.', { fields: errors });
    }
    const at = now();
    // Claimed together with the validated submission, so a run that stops part-way is finished
    // by the processing cycle from what the customer submitted.
    const claimed = await B2CRegistrationRequest.findOneAndUpdate(
      { _id: request._id, tokenHash: request.tokenHash, expiresAt: { $gt: at }, $or: [{ status: { $in: OPEN_REGISTRATION } }, { status: 'processing', lockedUntil: { $lt: at } }] },
      { $set: { status: 'processing', lockedUntil: new Date(at.getTime() + LOCK_MS), submission: values, submittedAt: at } }, { new: true });
    if (!claimed) throw linkError(409, 'used', 'This registration link has already been used.');
    try {
      await saveRegistration(claimed);
    } catch (error) {
      await releaseSubmission(claimed);
      throw error;
    }
    // Saved. The ticket is created now; if that fails, the processing cycle creates it.
    try { await resumeTicketAfterRegistration(claimed._id, settings); } catch (error) { logger.warn(`[B2C] Creating the ticket after registration ${claimed._id} failed: ${safeErrorMessage(error)}`); }
    return { state: 'submitted', reference: claimed.reference || null };
  }

  // A submission that could not be saved: the link can be used again, and nothing was completed.
  async function releaseSubmission(claimed) {
    await B2CRegistrationRequest.updateOne({ _id: claimed._id, status: 'processing', lockedUntil: claimed.lockedUntil }, { $set: { status: 'in_progress', lockedUntil: null }, $unset: { submission: '', submittedAt: '' } });
  }

  // Checks the claimed submission against the device and customer records and saves the
  // result: the customer's purchase record when a new one is needed, and the request's outcome,
  // together (in one transaction where the database supports them). The request is completed
  // only once the record is written. Run again after a partial run, it finds that purchase record
  // as the device's owner ('existing'), so no customer is duplicated.
  async function saveRegistration(claimed) {
    const values = claimed.toObject().submission;
    const phones = [values.phone, values.alternatePhone].filter(Boolean).map(normalisePhone).filter(Boolean);
    // The serial number is optional: without one there is nothing to look up by it.
    const bySerial = directory => (values.serialNumber ? directory.findBySerial(values.serialNumber) : []);
    const [devices, serialOwners, byEmail, ...byPhone] = await Promise.all([
      bySerial(deviceDirectory), bySerial(customerDirectory), customerDirectory.findByEmail(values.email), ...phones.map(phone => customerDirectory.findByPhone(phone)),
    ]);
    const decision = resolveRegistration({ values, devices, serialOwners, candidates: [...byEmail, ...byPhone.flat()], toleranceDays: registrationConfig.purchaseDateToleranceDays });
    const verified = decision.status === 'verified';
    await withTransaction(async session => {
      let records = decision.records || [];
      // A new purchase record only for a verified customer and an unregistered device.
      if (verified && decision.customerRecord !== 'existing') records = [...records, await customerDirectory.create(decision.customer, { session })];
      const used = decision.customerRecord === 'existing' ? decision.customer : records[records.length - 1];
      const saved = await B2CRegistrationRequest.updateOne({ _id: claimed._id, status: 'processing', lockedUntil: claimed.lockedUntil }, { $set: {
        status: verified ? 'completed' : 'manual_review', reason: decision.reason, completedAt: verified ? now() : null, lockedUntil: null,
        outcome: {
          customerRecord: verified ? decision.customerRecord : null, customerIds: verified ? [...new Set(records.map(item => item.customerId).filter(Number.isInteger))] : [],
          name: verified ? used?.name : undefined, email: verified ? used?.email : undefined, phone: verified ? used?.mobileNumber : undefined,
          deviceId: decision.device?._id || null, model: decision.device?.model || null, region: decision.region || null, checks: decision.checks,
        },
      } }, { session });
      if (saved.modifiedCount !== 1) throw new Error('The registration was taken over by another run while it was being saved.');
    });
  }

  // A link that may no longer be used: the case goes to an admin.
  async function withdrawRegistration(request, reason, settings) {
    const updated = await B2CRegistrationRequest.findOneAndUpdate({ _id: request._id, status: { $in: OPEN_REGISTRATION } }, { $set: { status: 'manual_review', reason } }, { new: true });
    if (updated) await resumeTicketAfterRegistration(updated._id, settings);
  }

  // Continues from a saved submission. A completed registration creates the ticket from the
  // original email (or continues the request's existing ticket): customer, device region,
  // routing, acknowledgement. One that needs review creates no ticket and waits for an admin.
  // Claimed so the submission and the processing cycle do not both run it, and repeatable
  // until it finishes: the ticket is unique per email. Returns the ticket, if there is one.
  async function resumeTicketAfterRegistration(requestId, settings) {
    const at = now();
    const request = await B2CRegistrationRequest.findOneAndUpdate(
      { _id: requestId, status: { $in: ['completed', 'manual_review'] }, resumedAt: null, $or: [{ resumingUntil: null }, { resumingUntil: { $lt: at } }] },
      { $set: { resumingUntil: new Date(at.getTime() + LOCK_MS) } }, { new: true }).lean();
    if (!request) return null;
    let ticket = request.ticketId ? await B2CEscalation.findById(request.ticketId) : null;
    try {
      if (!request.ticketId) {
        if (request.status === 'completed') ticket = await createTicketAfterRegistration(request, settings);
        else await auditRequestOnce(request, 'registration_needs_review', { details: { reason: request.reason, checks: request.outcome?.checks } });
      }
    } catch (error) {
      // Released so the next processing cycle retries it straight away.
      await B2CRegistrationRequest.updateOne({ _id: request._id, resumedAt: null }, { $set: { resumingUntil: null } });
      throw error;
    }
    if (ticket) {
      const { outcome = {}, submission = {} } = request;
      if (request.status === 'completed' && regionOpen(ticket)) {
        const matchedBy = (outcome.checks || []).filter(check => check.startsWith('matched_')).map(check => check.slice('matched_'.length));
        const previous = ticket.toObject().regionAssignment || {};
        if (submission.serialNumber && !ticket.identifiers.some(item => item.type === 'serialNumber' && item.value === submission.serialNumber)) ticket.identifiers.push({ type: 'serialNumber', value: submission.serialNumber, ruleKey: 'registration', source: 'registration' });
        ticket.customerMatch = { status: 'matched', method: 'registration', matchedBy: ['registration', ...matchedBy], customerIds: outcome.customerIds || [], name: outcome.name, email: outcome.email, evaluatedAt: now() };
        // The region is the device record's, as for every other ticket; never the customer's
        // address or the region they stated. A device without one, or no serial number at all,
        // goes to manual triage.
        const regionMissing = submission.serialNumber ? 'device_region_missing' : 'serial_number_missing';
        const device = { serialNumber: submission.serialNumber || null, emailSerialNumber: previous.emailSerialNumber || null, ownerCheck: 'verified', deviceId: outcome.deviceId, model: outcome.model, evaluatedAt: now() };
        ticket.regionAssignment = outcome.region
          ? { status: 'automatic', region: outcome.region, source: 'device_location', reason: null, ...device }
          : { status: 'unresolved', region: null, source: null, reason: regionMissing, ...device };
        ticket.region = outcome.region || '';
        ticket.customer = { email: ticket.customer.email, name: outcome.name || ticket.customer.name, phone: outcome.phone || ticket.customer.phone || '', crmCustomerId: ticket.customer.crmCustomerId || '' };
        setRegistration(ticket, { status: 'completed', reason: null, completedAt: request.completedAt });
        await ticket.save();
        // Which checks passed and which record was used; never the submitted values.
        const recorded = await auditOnce(ticket, 'registration_completed', { details: { customerRecord: outcome.customerRecord, checks: outcome.checks, region: outcome.region, deviceId: outcome.deviceId ? String(outcome.deviceId) : null } });
        const routing = { customerMatch: 'registration', matchedBy: ['registration', ...matchedBy], deviceId: outcome.deviceId ? String(outcome.deviceId) : null, ownerCheck: 'verified' };
        if (recorded) await audit(ticket, outcome.region ? 'region_identified' : 'region_not_identified', { details: outcome.region ? { region: outcome.region, source: 'device_location', ...routing } : { reason: regionMissing, ...routing } });
        if (ticket.crm?.status === 'pending') await enrichFromCrm(ticket);
        else if (crmConnector.isConfigured() && ticket.crm?.status !== 'matched') { ticket.crm.attempts = 0; await enrichFromCrm(ticket); }
        // Routed to the region's queue or Cluster Manager, or to manual triage with the reason.
        if (triageOpen(ticket)) await evaluateTriage(ticket, settings);
      } else if (request.status === 'completed') {
        // Routed by staff in the meantime: recorded, and the routing is left as it is.
        setRegistration(ticket, { status: 'completed', reason: null, completedAt: request.completedAt });
        await ticket.save();
        await auditOnce(ticket, 'registration_completed', { details: { customerRecord: outcome.customerRecord, routingUnchanged: true } });
      } else {
        setRegistration(ticket, { status: 'manual_review', reason: request.reason });
        await ticket.save();
        await auditOnce(ticket, 'registration_needs_review', { details: { reason: request.reason, checks: outcome.checks } });
        if (triageOpen(ticket)) await evaluateTriage(ticket, settings);
      }
      // Acknowledged now that the ticket exists (once: the acknowledgement is unique per ticket),
      // by the usual rules: a verified customer is acknowledged; one under review only under policy 'sender'.
      await queueAcknowledgement(ticket);
      await appendWaitingReplies(request._id, ticket);
    }
    await B2CRegistrationRequest.updateOne({ _id: request._id }, { $set: { resumedAt: now(), resumingUntil: null } });
    return ticket;
  }

  // The ticket of a completed registration, created from the original email.
  async function createTicketAfterRegistration(request, settings) {
    const record = await B2CInboundEmail.findById(request.sourceEmailId);
    if (!record) throw Object.assign(new Error('The original email of this registration request no longer exists.'), { retryable: false });
    const ticket = await createTicketRecord(record, settings, { via: 'registration' });
    await B2CInboundEmail.updateOne({ _id: record._id }, { $set: { outcome: 'ticket_created_after_registration' } });
    await linkRequestToTicket(request, ticket, 'registration');
    return ticket;
  }

  // A B2C admin proceeds without the customer's registration: the ticket is created from the
  // original email and decided in triage like any other. An open link is withdrawn; a
  // submission under review stays on the ticket for the admin to see.
  async function createTicketWithoutRegistration(request, settings, user, note) {
    const record = await B2CInboundEmail.findById(request.sourceEmailId);
    if (!record) throw new B2CError('The original email of this request no longer exists.', 409);
    await B2CRegistrationRequest.updateOne({ _id: request._id, ticketId: null, status: { $in: [...OPEN_REGISTRATION, 'required', 'expired'] } }, { $set: { status: 'cancelled', reason: 'ticket_created_by_staff' } });
    const ticket = await createTicketRecord(record, settings, { via: 'staff' });
    await B2CInboundEmail.updateOne({ _id: record._id }, { $set: { outcome: 'ticket_created_by_staff' } });
    await linkRequestToTicket(request, ticket, 'staff');
    await auditOnce(ticket, 'ticket_created_without_registration', { actor: user, note, details: { registrationStatus: request.status, registrationReason: request.reason || null } });
    await continueTicketFromEmail(ticket, settings, record);
    await appendWaitingReplies(request._id, ticket);
    return ticket;
  }

  // The new ticket takes over the request: its id and reference, the request's history and
  // registration emails, and the registration state mirrored for triage and the queue.
  async function linkRequestToTicket(request, ticket, by) {
    await B2CRegistrationRequest.updateOne({ _id: request._id, ticketId: null }, { $set: { ticketId: ticket._id, reference: ticket.reference, ticketCreatedBy: by, ticketCreatedAt: now() } });
    await B2CAuditEvent.updateMany({ registrationId: request._id, ticketId: null }, { $set: { ticketId: ticket._id, reference: ticket.reference } });
    await B2COutboundEmail.updateMany({ registrationId: request._id, ticketId: null }, { $set: { ticketId: ticket._id } });
    const current = await B2CRegistrationRequest.findById(request._id).lean();
    setRegistration(ticket, { status: current.status, requestId: current._id, reason: current.reason || null, requestedAt: current.createdAt, ...(current.completedAt ? { completedAt: current.completedAt } : {}) });
    await ticket.save();
  }

  // Replies to the registration email that arrived before the ticket existed join its
  // conversation. Last, as a reply updates the ticket directly.
  async function appendWaitingReplies(requestId, ticket) {
    const { relatedEmailIds = [] } = await B2CRegistrationRequest.findById(requestId).select('relatedEmailIds').lean() || {};
    for (const id of relatedEmailIds) {
      const reply = await B2CInboundEmail.findOneAndUpdate({ _id: id, ticketId: null }, { $set: { ticketId: ticket._id } }, { new: true });
      if (reply) await appendCustomerReply(ticket, reply);
    }
  }

  // A customer's reply to the registration email of a request that has no ticket yet.
  async function findThreadRegistration(record) {
    const messageIds = [record.inReplyTo, ...(record.references || [])].filter(Boolean);
    if (!messageIds.length) return null;
    const outbound = await B2COutboundEmail.findOne({ messageId: { $in: messageIds }, kind: 'registration', ticketId: null }).select('registrationId').lean();
    const original = outbound ? null : await B2CInboundEmail.findOne({ internetMessageId: { $in: messageIds }, ticketId: null }).select('_id').lean();
    const request = outbound ? await B2CRegistrationRequest.findById(outbound.registrationId).lean() : original ? await B2CRegistrationRequest.findOne({ sourceEmailId: original._id }).lean() : null;
    // Only the customer the link was sent to adds to it.
    return request && !request.ticketId && request.recipient === String(record.from?.address || '').trim().toLowerCase() ? request : null;
  }

  async function expireRegistration(request) {
    const expired = await B2CRegistrationRequest.findOneAndUpdate({ _id: request._id, status: { $in: OPEN_REGISTRATION }, expiresAt: { $lte: now() } }, { $set: { status: 'expired' } }, { new: true });
    if (!expired) return;
    if (!expired.ticketId) {
      await auditRequest(expired, 'registration_expired', { details: { sendCount: expired.sendCount } });
      return;
    }
    const ticket = await B2CEscalation.findOne({ _id: expired.ticketId, 'registration.requestId': expired._id });
    if (!ticket) return;
    setRegistration(ticket, { status: 'expired' });
    await ticket.save();
    await audit(ticket, 'registration_expired', { details: { sendCount: expired.sendCount } });
    if (triageOpen(ticket)) await evaluateTriage(ticket, await getSettings());
    await queueAcknowledgement(ticket);
  }

  // Run each cycle: links past their expiry, submissions whose run stopped part-way, and saved
  // registrations whose ticket was not created (or continued) yet.
  // Saved registrations get their ticket even if the feature has been turned off since.
  async function sweepRegistrations({ limit = 50 } = {}) {
    const due = registrationConfig.enabled ? await B2CRegistrationRequest.find({ status: { $in: OPEN_REGISTRATION }, expiresAt: { $lte: now() } }).limit(limit) : [];
    for (const request of due) await expireRegistration(request);
    const stalled = await B2CRegistrationRequest.find({ status: 'processing', lockedUntil: { $lt: now() }, submittedAt: { $ne: null } }).limit(limit);
    for (const request of stalled) {
      const claimed = await B2CRegistrationRequest.findOneAndUpdate({ _id: request._id, status: 'processing', lockedUntil: request.lockedUntil }, { $set: { lockedUntil: new Date(now().getTime() + LOCK_MS) } }, { new: true });
      if (!claimed) continue;
      try { await saveRegistration(claimed); } catch (error) {
        await releaseSubmission(claimed);
        logger.warn(`[B2C] Saving registration ${request._id} failed: ${safeErrorMessage(error)}`);
      }
    }
    const unresumed = await B2CRegistrationRequest.find({ status: { $in: ['completed', 'manual_review'] }, resumedAt: null }).select('_id').limit(limit).lean();
    const settings = unresumed.length ? await getSettings() : null;
    for (const request of unresumed) {
      try { await resumeTicketAfterRegistration(request._id, settings); } catch (error) { logger.warn(`[B2C] Continuing registration ${request._id} failed: ${safeErrorMessage(error)}`); }
    }
    return { expired: due.length, recovered: stalled.length, resumed: unresumed.length };
  }

  // The customer asks for a new link from an expired one. The answer is always the same; a
  // link is sent only to the address the original went to, within the resend limits.
  async function renewRegistration(token) {
    const answer = { state: 'renewal_requested' };
    if (!registrationConfig.enabled || !isRegistrationToken(token)) return answer;
    const request = await findRegistration(token).catch(error => { if (error instanceof B2CError) return null; throw error; });
    if (request?.status !== 'expired') return answer;
    try { await resendRegistration(request, { settings: await getSettings(), trigger: 'customer_renewal' }); } catch (error) { if (!(error instanceof B2CError)) throw error; }
    return answer;
  }

  // Staff triaged or closed the ticket: the link is no longer needed.
  async function cancelRegistration(ticket, actor) {
    if (!ticket.registration?.requestId) return false;
    const request = await B2CRegistrationRequest.findOneAndUpdate({ _id: ticket.registration.requestId, status: { $in: [...OPEN_REGISTRATION, 'expired', 'required'] } }, { $set: { status: 'cancelled', reason: 'resolved_by_staff' } }, { new: true });
    if (!request) return false;
    setRegistration(ticket, { status: 'cancelled', reason: 'resolved_by_staff' });
    await audit(ticket, 'registration_cancelled', { actor, details: { previous: ticket.registration?.status || null } });
    return true;
  }

  // For staff: the state, timestamps and reason; never the token. The submitted details are
  // shown only to a B2C admin, and only while they need a decision.
  async function registrationSummary(ticket, user) {
    const state = ticket.registration;
    if (!state?.status) return null;
    const request = state.requestId ? await B2CRegistrationRequest.findById(state.requestId).select('-tokenHash').lean() : null;
    if (!request) return { status: state.status, reason: state.reason || null, requestedAt: state.requestedAt || null, canResend: false };
    const review = request.status === 'manual_review' && isAdmin(user);
    return {
      status: request.status, reason: request.reason || null, recipient: maskEmail(request.recipient), requestedAt: request.createdAt, lastQueuedAt: request.lastQueuedAt, lastSentAt: request.lastSentAt,
      openedAt: request.openedAt, submittedAt: request.submittedAt, completedAt: request.completedAt, expiresAt: request.expiresAt, sendCount: request.sendCount, maxSends: registrationConfig.maxSends,
      failedAttempts: request.failedAttempts, outcome: request.outcome ? { customerRecord: request.outcome.customerRecord, region: request.outcome.region, checks: request.outcome.checks } : null,
      submission: review ? request.submission : null, assigned: Boolean(ticket.workflow?.assignee?.userId), ticketCreatedBy: request.ticketCreatedBy || null,
    };
  }
  async function registrationActionAllowed(ticket) {
    if (!registrationConfig.enabled || ticket.customerMatch?.status === 'matched') return false;
    const request = ticket.registration?.requestId ? await B2CRegistrationRequest.findById(ticket.registration.requestId).select('status sendCount').lean() : null;
    return !request || (!['completed', 'processing'].includes(request.status) && (request.sendCount || 0) < registrationConfig.maxSends);
  }

  // ---- Registration requests without a ticket (B2C admins) ------------------------------
  // Emails waiting for the customer to register, and those that need a decision (a submission
  // under review, an expired link, no email sent, or a registration whose ticket is not created yet).
  const DECISION_STATUSES = ['required', 'manual_review', 'expired', 'completed'];
  function registrationActions(request) {
    if (request.ticketId || request.status === 'processing') return [];
    const actions = [];
    if (!['completed', 'cancelled'].includes(request.status) && (request.sendCount || 0) < registrationConfig.maxSends && registrationConfig.enabled) actions.push('resend');
    // A completed registration creates its ticket by itself; this retries one that failed.
    actions.push('create_ticket');
    return actions;
  }
  const registrationRow = request => ({
    id: String(request._id), status: request.status, reason: request.reason || null, trigger: request.trigger || null, recipient: maskEmail(request.recipient),
    subject: request.subject || '', inboxKey: request.inboxKey || null, requestedAt: request.createdAt, lastQueuedAt: request.lastQueuedAt || null, lastSentAt: request.lastSentAt || null,
    openedAt: request.openedAt || null, submittedAt: request.submittedAt || null, completedAt: request.completedAt || null, expiresAt: request.expiresAt || null,
    sendCount: request.sendCount || 0, maxSends: registrationConfig.maxSends, failedAttempts: request.failedAttempts || 0, relatedEmails: (request.relatedEmailIds || []).length,
    outcome: request.outcome?.checks?.length ? { customerRecord: request.outcome.customerRecord, region: request.outcome.region, checks: request.outcome.checks } : null,
    actions: registrationActions(request),
  });
  async function listRegistrations(query = {}) {
    const filter = { ticketId: null };
    const status = typeof query.status === 'string' ? query.status : '';
    if (status === 'open') filter.status = { $in: [...OPEN_REGISTRATION, 'processing'] };
    else if (status === 'decide') filter.status = { $in: DECISION_STATUSES };
    else if (REGISTRATION_STATUSES.includes(status)) filter.status = status;
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 25));
    const [items, total, counts] = await Promise.all([
      B2CRegistrationRequest.find(filter).select('-tokenHash -submission').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      B2CRegistrationRequest.countDocuments(filter),
      B2CRegistrationRequest.aggregate([{ $match: { ticketId: null } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    return { items: items.map(registrationRow), total, page, limit, counts: Object.fromEntries(counts.map(item => [item._id, item.count])) };
  }
  async function loadRequest(id) {
    const request = mongoose.isValidObjectId(id) ? await B2CRegistrationRequest.findById(id) : null;
    if (!request) throw new B2CError('Registration request not found', 404);
    return request;
  }
  // One request: its state, its history and, while it needs a decision, what the customer submitted.
  async function getRegistration(id) {
    const request = (await loadRequest(id)).toObject();
    const history = await B2CAuditEvent.find(request.ticketId ? { ticketId: request.ticketId, action: /^registration/ } : { registrationId: request._id }).sort({ at: 1 }).lean();
    return {
      ...registrationRow(request), ticketId: request.ticketId ? String(request.ticketId) : null, reference: request.reference || null, ticketCreatedBy: request.ticketCreatedBy || null,
      submission: request.status === 'manual_review' ? request.submission || null : null,
      history: history.map(event => ({ _id: String(event._id), action: event.action, actor: { name: event.actor?.name || 'System', role: event.actor?.role || 'system' }, at: event.at, details: event.details || {}, note: event.note || null })),
    };
  }
  async function registrationAction(id, action, payload = {}, user) {
    const request = await loadRequest(id);
    if (!registrationActions(request).includes(action)) throw new B2CError('This action is not available for this registration request now.', 409);
    const settings = await getSettings();
    if (action === 'resend') {
      await resendRegistration(request, { actor: user, settings, trigger: 'staff' });
      await sendPendingOutbound({ limit: 5 });
      return getRegistration(id);
    }
    if (request.status === 'completed') {
      const ticket = await resumeTicketAfterRegistration(request._id, settings);
      if (!ticket) throw new B2CError('The ticket for this registration is being created. Refresh in a moment.', 409);
      return { ticketId: String(ticket._id), reference: ticket.reference };
    }
    const ticket = await createTicketWithoutRegistration(request, settings, user, requiredText(payload, 'reason'));
    return { ticketId: String(ticket._id), reference: ticket.reference };
  }

  // What an outbound email is about: its ticket or, for a registration email sent before the
  // ticket exists, a stand-in from its request (no reference number: there is none yet).
  async function outboundSubject(outbound) {
    if (outbound.ticketId) return B2CEscalation.findById(outbound.ticketId).lean();
    const request = outbound.kind === 'registration' && outbound.registrationId ? await B2CRegistrationRequest.findById(outbound.registrationId).lean() : null;
    return request ? { _id: null, subject: request.subject || '', summary: request.issueSummary || '', customer: { name: '' }, inboxKey: request.inboxKey, request } : null;
  }
  const auditOutbound = (subject, action, options) => (subject.request ? auditRequest(subject.request, action, options) : audit(subject, action, options));

  async function sendOutbound(outbound, settings) {
    const inbox = settings.inboxes.find(item => item.key === outbound.inboxKey);
    if (outbound.via === 'company_sender') return sendFromCompany(outbound, settings);
    if (inbox && !emailConnectors.canSend(inbox)) {
      // IMAP inboxes only read mail: the message stays on the ticket, marked as not sent.
      Object.assign(outbound, { status: 'skipped', heldReason: 'receive_only_inbox', provider: inbox.provider, lockedUntil: null, nextAttemptAt: null, lastError: null, attempts: Math.max(0, outbound.attempts - 1) });
      await outbound.save();
      await syncOutbound(outbound, 'skipped', null, 'receive_only_inbox');
      const subject = await outboundSubject(outbound);
      if (subject) await auditOutbound(subject, 'email_not_sent', { details: { kind: outbound.kind, provider: inbox.provider, reason: 'receive_only_inbox' } });
      return outbound;
    }
    const template = settings.templates.find(item => item.key === outbound.templateKey);
    if (!template?.approved) {
      // Automated customer email only uses wording TCM has approved.
      Object.assign(outbound, { status: 'held', heldReason: 'template_not_approved', lockedUntil: null, attempts: Math.max(0, outbound.attempts - 1) });
      await outbound.save();
      await syncOutbound(outbound, 'held');
      return outbound;
    }
    const ticket = await outboundSubject(outbound);
    const described = (inbox && emailConnectors.describeOutbound(inbox)) || { mode: 'disabled' };
    const integration = { kind: 'outbound', label: 'Outbound customer email', provider: described.provider || inbox?.provider, mode: described.mode };
    try {
      if (!ticket) throw Object.assign(new Error('Escalation no longer exists'), { retryable: false });
      if (!inbox) throw Object.assign(new Error(`Inbox "${outbound.inboxKey}" is no longer configured`), { retryable: false });
      const connector = emailConnectors.forOutbound(inbox);
      const { rendered, stored } = await renderForSending(outbound, template, ticket);
      // Saved before sending: if the process stops after the server accepted the message,
      // the retry reuses this Message-ID so mail clients can recognise the duplicate.
      outbound.messageId = outbound.messageId || `<${outbound._id}.${crypto.randomBytes(6).toString('hex')}@${config.messageIdDomain}>`;
      outbound.subject = stored.subject;
      outbound.bodyText = stored.body;
      outbound.provider = connector.provider;
      await outbound.save();
      const result = await connector.send({ inbox, to: outbound.to, subject: rendered.subject, text: rendered.body, messageId: outbound.messageId, reference: ticket.reference });
      Object.assign(outbound, { status: 'sent', sentAt: now(), providerMessageId: result?.providerMessageId || null, responseCode: result?.responseCode || null, mode: connector.mode, lockedUntil: null, lastError: null, heldReason: null });
      await outbound.save();
      await syncOutbound(outbound, 'sent', outbound.sentAt);
      await recordIntegration('outbound', { ...integration, ok: true });
      // 'Sent' is the provider accepting the message; delivery to the mailbox is not confirmed.
      await auditOutbound(ticket, 'email_sent', { details: { kind: outbound.kind, mode: connector.mode, provider: connector.provider, ...(result?.responseCode ? { responseCode: result.responseCode } : {}) } });
    } catch (error) {
      const permanent = error?.retryable === false || outbound.attempts >= config.maxSendAttempts;
      Object.assign(outbound, { status: permanent ? 'failed' : 'retrying', lastError: safeErrorMessage(error), nextAttemptAt: permanent ? null : new Date(now().getTime() + backoffMs(outbound.attempts)), lockedUntil: null });
      await outbound.save();
      if (permanent) await syncOutbound(outbound, 'failed');
      await recordIntegration('outbound', { ...integration, ok: false, error });
      if (ticket) await auditOutbound(ticket, 'email_send_failed', { details: { kind: outbound.kind, provider: described.provider || null, attempt: outbound.attempts, willRetry: !permanent, error: safeErrorMessage(error) } });
    }
    return outbound;
  }

  // An acknowledgement sent from the separate company address over SMTP. Marked sent only
  // once the server accepts it; the Message-ID is saved first so a retry after an
  // unconfirmed hand-over reuses it. That makes a duplicate recognisable, not impossible:
  // SMTP cannot tell us whether a message was accepted when the connection drops.
  async function sendFromCompany(outbound, settings) {
    const template = settings.templates.find(item => item.key === outbound.templateKey);
    if (!template?.approved) {
      Object.assign(outbound, { status: 'held', heldReason: 'template_not_approved', lockedUntil: null, attempts: Math.max(0, outbound.attempts - 1) });
      await outbound.save();
      await syncOutbound(outbound, 'held');
      return outbound;
    }
    const ticket = await outboundSubject(outbound);
    const integration = { kind: 'outbound', label: 'Acknowledgement sender', provider: 'smtp', mode: ackSender?.isConfigured() ? 'live' : 'not_configured' };
    try {
      if (!ticket) throw Object.assign(new Error('Escalation no longer exists'), { retryable: false });
      if (!ackSender?.enabled) throw Object.assign(new Error('The acknowledgement sender is turned off (B2C_ACK_EMAIL_ENABLED).'), { retryable: false });
      const { rendered, stored } = await renderForSending(outbound, template, ticket);
      outbound.messageId = outbound.messageId || `<${outbound._id}.${crypto.randomBytes(6).toString('hex')}@${config.messageIdDomain}>`;
      Object.assign(outbound, { subject: stored.subject, bodyText: stored.body, provider: ackSender.provider, from: ackSender.fromEmail });
      await outbound.save();
      const result = await ackSender.send({ to: outbound.to, replyTo: outbound.replyTo, subject: rendered.subject, text: rendered.body, messageId: outbound.messageId });
      Object.assign(outbound, { status: 'sent', sentAt: now(), providerMessageId: result?.providerMessageId || null, responseCode: result?.responseCode || null, mode: ackSender.mode, lockedUntil: null, lastError: null, heldReason: null });
      await outbound.save();
      await syncOutbound(outbound, 'sent', outbound.sentAt);
      await recordIntegration('ack_sender', { ...integration, ok: true });
      // 'Sent' is the SMTP server accepting the message; delivery to the mailbox is not confirmed.
      await auditOutbound(ticket, 'email_sent', { details: { kind: outbound.kind, mode: ackSender.mode, provider: ackSender.provider, via: 'company_sender', ...(result?.responseCode ? { responseCode: result.responseCode } : {}) } });
    } catch (error) {
      const permanent = error?.retryable === false || outbound.attempts >= config.maxSendAttempts;
      Object.assign(outbound, { status: permanent ? 'failed' : 'retrying', lastError: safeErrorMessage(error), nextAttemptAt: permanent ? null : new Date(now().getTime() + backoffMs(outbound.attempts)), lockedUntil: null });
      await outbound.save();
      if (permanent) await syncOutbound(outbound, 'failed');
      await recordIntegration('ack_sender', { ...integration, ok: false, error });
      if (ticket) await auditOutbound(ticket, 'email_send_failed', { details: { kind: outbound.kind, provider: 'smtp', via: 'company_sender', attempt: outbound.attempts, willRetry: !permanent, error: safeErrorMessage(error) } });
    }
    return outbound;
  }

  async function sendPendingOutbound({ limit = 50 } = {}) {
    const settings = await getSettings();
    // Held messages go back into the queue once their template is approved.
    const approved = settings.templates.filter(item => item.approved).map(item => item.key);
    if (approved.length) await B2COutboundEmail.updateMany({ status: 'held', heldReason: 'template_not_approved', templateKey: { $in: approved } }, { $set: { status: 'queued', heldReason: null, nextAttemptAt: now() } });
    // Held messages of receive-only inboxes will never be sent; requeue them to be recorded as skipped.
    const receiveOnly = settings.inboxes.filter(inbox => !emailConnectors.canSend(inbox)).map(inbox => inbox.key);
    if (receiveOnly.length) await B2COutboundEmail.updateMany({ status: 'held', inboxKey: { $in: receiveOnly }, via: { $ne: 'company_sender' } }, { $set: { status: 'queued', heldReason: null, nextAttemptAt: now() } });
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
      const registrations = await sweepRegistrations();
      const sent = await sendPendingOutbound();
      const slaEscalated = await evaluateSlaEscalations();
      scheduler.lastResult = { trigger, polled, processed: processed.length, crmRetried: crmRetried.length, registrationsExpired: registrations.expired, sent: sent.length, slaEscalated: slaEscalated.length };
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

  // Actions that give the ticket an engineer, after which it must have an acknowledgement.
  const ASSIGNING_ACTIONS = ['claim', 'assign', 'reroute'];
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
        // A manual region must be one already defined on device records.
        const regions = await deviceDirectory.regions();
        const asked = typeof payload.region === 'string' ? payload.region.trim() : '';
        const requested = asked ? regions.find(name => regionKey(name) === regionKey(asked)) : null;
        if (asked && !requested) throw new B2CError('Choose a region defined on the device records.');
        if (payload.userId && !mongoose.isValidObjectId(payload.userId)) throw new B2CError('Choose a valid staff member.');
        const regionReason = optionalText(payload, 'regionReason', LIMITS.reason);
        const known = new Set(ticket.identifiers.map(item => `${item.type}:${item.value}`));
        added.filter(item => !known.has(`${item.type}:${item.value}`)).forEach(item => ticket.identifiers.push(item));
        details.overriddenReasons = [...(ticket.triage?.reasons || [])];
        if (ticket.category !== payload.category) ticket.classification = { source: 'manual', matched: [], note: null };
        ticket.category = payload.category;
        note = optionalText(payload, 'note', LIMITS.note);
        if ((added.length || payload.rerunCrm) && crmConnector.isConfigured()) await enrichFromCrm(ticket, user);
        // Looked up again, so a serial number added here, or a device added since, is used.
        await assessRegion(ticket, settings, { actor: user });

        // Region: the one on the device record, or the admin's documented choice.
        const current = ticket.toObject().regionAssignment || {};
        const identified = current.status === 'automatic' ? current.region : null;
        const manual = Boolean(requested && requested !== identified);
        if (manual) {
          if (!regionReason) throw new B2CError(identified ? `The device record gives ${identified}. Give a reason for choosing ${requested} instead.` : 'Give a reason for the region you chose.');
          ticket.regionAssignment = { ...current, status: 'manual', region: requested, source: 'manual', reason: null, decidedBy: person(user), evaluatedAt: now(), note: regionReason };
          ticket.region = requested;
        } else if (!identified && regions.length) {
          throw new B2CError('No device record gives this escalation a region. Choose the region.');
        }
        // Checked against the region decided above, before anything is recorded.
        const chosen = payload.userId ? await chooseStaff(payload.userId, defaultPath(settings)[0], ticket) : null;
        if (manual) await audit(ticket, 'region_set', { actor: user, note: regionReason, details: { from: identified, to: requested, previousStatus: current.status || null, previousReason: current.reason || null } });
        // The admin decided: an open registration link is withdrawn.
        await cancelRegistration(ticket, user);
        await audit(ticket, 'triage_completed', { actor: user, fromStatus, details: { category: ticket.category, addedIdentifiers: added.map(item => item.type), overriddenReasons: details.overriddenReasons, region: ticket.region || null, regionStatus: ticket.regionAssignment?.status || null, assignee: chosen?.name || null }, note });
        await routeToWorkflow(ticket, settings, user, chosen);
        // An acknowledgement that waited for registration is decided now.
        if (ticket.registration?.status) await queueAcknowledgement(ticket);
        return getTicketDetail(id, user);
      }
      case 'send_registration': {
        if (!registrationConfig.enabled) throw new B2CError('Customer registration is not enabled (B2C_REGISTRATION_ENABLED).', 409);
        if (ticket.customerMatch?.status === 'matched') throw new B2CError('The customer is already identified; no registration is needed.', 409);
        const request = await B2CRegistrationRequest.findOne({ ticketId: ticket._id });
        if (request) await resendRegistration(request, { actor: user, settings, trigger: 'staff' });
        else await requestRegistration(ticket, settings, { actor: user, manual: true });
        await sendPendingOutbound({ limit: 5 });
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
        await cancelRegistration(ticket, user);
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
    if (ASSIGNING_ACTIONS.includes(action) && ticket.workflow?.assignee?.userId) await queueAcknowledgement(ticket, { onAssignment: true });
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
      B2COutboundEmail.find({ ticketId: ticket._id }).select('kind to subject bodyText status heldReason lastError sentAt createdAt mode provider responseCode createdBy attempts templateKey vars').sort({ createdAt: 1 }).lean(),
      B2CAuditEvent.find({ ticketId: ticket._id }).sort({ at: 1 }).lean(),
    ]);
    const conversation = [
      ...inbound.map(item => ({ _id: item._id, direction: 'inbound', at: item.receivedAt, from: item.from, to: item.to, subject: item.subject, bodyText: item.bodyText, bodyTruncated: item.bodyTruncated, attachments: (item.attachments || []).map(({ storageKey, ...rest }) => ({ ...rest, downloadKey: storageKey || null })) })),
      ...outbound.map(item => {
        // Unsent messages show what will be sent; sent ones show what was sent.
        const template = settings.templates.find(entry => entry.key === item.templateKey);
        const preview = item.status === 'sent' ? null : renderTemplate(template, templateVars(ticket, item.vars));
        return { _id: item._id, direction: 'outbound', kind: item.kind, at: item.sentAt || item.createdAt, to: item.to, subject: item.subject || preview?.subject, bodyText: item.bodyText || preview?.body, status: item.status, heldReason: item.heldReason, lastError: item.lastError, mode: item.mode, provider: item.provider, responseCode: item.responseCode, attempts: item.attempts, createdBy: item.createdBy };
      }),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
    const plain = ticket.toObject();
    const offerRegistration = await registrationActionAllowed(ticket);
    return {
      ticket: { ...plain, path: effectivePath(plain, settings) },
      conversation,
      audit: auditTrail,
      allowedActions: allowedActions({ ticket, user, settings }).filter(action => action !== 'send_registration' || offerRegistration),
      registration: await registrationSummary(ticket, user),
      workflow: {
        levels: enabledLevels(settings).map(level => ({ key: level.key, label: level.label })),
        nextLevel: nextLevel(ticket, settings),
        validatorLevel: ticket.status === STATUS.INVESTIGATING ? validatorLevelFor(ticket, settings) : ticket.validation?.validatorLevel ?? null,
        validationMode: settings.validation?.mode || 'next_level',
        // For the triage form: the level a routed ticket starts at, and the regions it can choose.
        firstLevel: defaultPath(settings)[0] || null,
        regions: await deviceDirectory.regions(),
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
    const regionStatus = pick(query.regionStatus);
    if (['automatic', 'manual', 'unresolved', 'pending'].includes(regionStatus)) and.push({ 'regionAssignment.status': regionStatus });
    const registrationStatus = pick(query.registrationStatus);
    if (registrationStatus === 'open') and.push({ 'registration.status': { $in: [...OPEN_REGISTRATION, 'processing'] } });
    else if (['completed', 'manual_review', 'expired', 'not_requested', 'cancelled'].includes(registrationStatus)) and.push({ 'registration.status': registrationStatus });
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
      B2CEscalation.find(filter).select('reference subject category status region regionAssignment.status regionAssignment.reason customer.name customer.email identifiers workflow triage crm.status acknowledgement.status registration.status createdAt updatedAt lastActivityAt lastCustomerMessageAt reopenCount slaStatus slaTargetAt escalationLevel escalationStatus').sort({ [sortField]: order, _id: order }).skip((page - 1) * limit).limit(limit).lean(),
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
      const [failedInbound, heldOutbound, failedOutbound, integrationErrors, awaitingRegistration, registrationDecisions] = await Promise.all([
        B2CInboundEmail.countDocuments({ status: { $in: ['failed', 'retrying'] } }),
        B2COutboundEmail.countDocuments({ status: 'held' }),
        B2COutboundEmail.countDocuments({ status: { $in: ['failed', 'retrying'] } }),
        B2CIntegrationStatus.countDocuments({ consecutiveFailures: { $gt: 0 } }),
        // Emails without a ticket: waiting for the customer to register, or for an admin's decision.
        B2CRegistrationRequest.countDocuments({ ticketId: null, status: { $in: [...OPEN_REGISTRATION, 'processing'] } }),
        B2CRegistrationRequest.countDocuments({ ticketId: null, status: { $in: DECISION_STATUSES } }),
      ]);
      result.health = { failedInbound, heldOutbound, failedOutbound, integrationErrors };
      result.registrations = { awaitingCustomer: awaitingRegistration, needDecision: registrationDecisions };
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
      inboxes: settings.inboxes.map(inbox => ({ key: inbox.key, address: inbox.address, displayName: inbox.displayName, enabled: inbox.enabled, defaultCategory: inbox.defaultCategory, ...emailConnectors.describe(inbox), outbound: emailConnectors.describeOutbound(inbox), status: byKey[`email:${inbox.key}`] || null })),
      crm: { provider: crmConnector.provider, mode: crmConnector.isConfigured() ? crmConnector.mode : 'not_configured', configured: crmConnector.isConfigured(), status: byKey.crm || null },
      outbound: byKey.outbound || null,
      // The separate acknowledgement sender: server and missing variable names, never credentials.
      ackSender: ackSender ? { enabled: Boolean(ackSender.enabled), ...ackSender.configCheck?.(), server: ackSender.describeServer?.() || null, unmatchedPolicy: config.ack?.unmatchedPolicy || 'verified', status: byKey.ack_sender || null } : null,
      scheduler: { pollMinutes: config.pollMinutes, running: scheduler.running, lastRunAt: scheduler.lastRunAt, lastResult: scheduler.lastResult, lastError: scheduler.lastError, status: byKey.scheduler || null },
      queues: { inbound: counts(inboundCounts), outbound: counts(outboundCounts), triage },
      testAdapters: { email: Boolean(emailConnectors.get('test')), crm: crmConnector.mode === 'test' },
      imap: emailConnectors.get('imap') ? { ...imapSummary(emailConnectors.get('imap')), inboxes: settings.inboxes.filter(inbox => inbox.provider === 'imap').map(inbox => inbox.key), status: byKey.imap || null } : null,
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
    const status = ['held', 'failed', 'retrying', 'queued', 'sent', 'skipped'].includes(query.status) ? query.status : null;
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

  // ---- IMAP connection test (B2C admin) ----------------------------------------------------
  // Logs in and opens the mailbox folder; reads and changes nothing. Each admin gets a few
  // attempts per window (repeated failed logins can get the server IP blocked).
  const IMAP_TEST_LIMIT = 5;
  const IMAP_TEST_WINDOW_MS = 15 * MINUTE;
  const imapAttempts = new Map();
  function imapSummary(adapter) {
    const { configured, missing } = adapter.configCheck();
    return { configured, missing, server: adapter.describeServer() };
  }
  function takeImapAttempt(user) {
    const at = now().getTime();
    const recent = (imapAttempts.get(user.id) || []).filter(time => at - time < IMAP_TEST_WINDOW_MS);
    if (recent.length >= IMAP_TEST_LIMIT) throw new B2CError(`Too many IMAP checks. Try again in ${Math.ceil((IMAP_TEST_WINDOW_MS - (at - recent[0])) / MINUTE)} minute(s).`, 429);
    imapAttempts.set(user.id, [...recent, at]);
  }

  async function verifyImap(user) {
    const adapter = emailConnectors.get('imap');
    if (!adapter) throw new B2CError('IMAP is not available in this environment.', 404);
    takeImapAttempt(user);
    const integration = { kind: 'email', label: 'IMAP mailbox', provider: 'imap', mode: adapter.isConfigured() ? 'live' : 'not_configured', details: { check: 'connection' } };
    let result;
    try {
      await adapter.verify();
      result = { ok: true, message: 'Connected, signed in and opened the mailbox folder. No email was read or changed.' };
      await recordIntegration('imap', { ...integration, ok: true });
    } catch (error) {
      // Our own wording for known failures, never a raw server reply.
      result = { ok: false, error: error instanceof ConnectorError ? error.message : 'The IMAP check failed.', retryable: error?.retryable !== false };
      await recordIntegration('imap', { ...integration, ok: false, error });
    }
    await auditGeneral('imap_connection_tested', user, { details: { ok: result.ok }, link: '/b2c/integrations' });
    return { ...result, ...imapSummary(adapter) };
  }

  return {
    getSettings, updateSettings, ingestMessage, pollInbox, processPendingInbound, processInbound, retryCrmLookups, sendPendingOutbound, runCycle,
    performAction, getTicketDetail, listTickets, dashboard, reports, health, listInbound, retryInbound, listOutbound, retryOutbound, attachmentFor,
    injectTestEmail, testOutbox, verifyImap, staffForUser, schedulerStatus: () => ({ ...scheduler }),
    // Public, token-only customer registration.
    openRegistration, submitRegistration, renewRegistration, sweepRegistrations,
    // Registration requests without a ticket (B2C admins).
    listRegistrations, getRegistration, registrationAction,
  };
}
