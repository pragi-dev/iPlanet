import dotenv from 'dotenv';
import express from 'express';
import compression from 'compression';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { User, Company, ServiceCentre, Device, DeviceMaster, Engineer, Ticket, TicketTimeline, Review, Notification, EscalationRule, CallRecord, AITroubleshootingSession, ServiceFollowUp, AccountRequest, EmailRequest, TicketEmail, GoogleBusinessIntegration, GoogleBusinessLocationMapping, GoogleBusinessNotificationReceipt, Customer } from './models.js';
import { auth, allowRoles, jwtSecret, restrictB2COnlyStaff } from './middleware.js';
import { hashPassword, verifyPassword, needsRehash } from './passwords.js';
import { createCorsMiddleware } from './corsPolicy.js';
import { computeSlaEscalation, targetHours } from './slaEscalation.js';
import { createAiSupportRouter } from './routes/aiSupport.js';
import { createGoogleBusinessRouter } from './routes/googleBusiness.js';
import { getGoogleBusinessOauthConfig, validateGoogleBusinessOauthConfig } from './integrations/googleBusinessProfile/googleBusinessProfileAuth.js';
import { createMongoGoogleBusinessStore, GOOGLE_BUSINESS_PROVIDER } from './integrations/googleBusinessProfile/googleBusinessProfileStore.js';
import { getPubSubPushConfig, isPubSubPushConfigured } from './integrations/googleBusinessProfile/googleBusinessProfilePubSub.js';
import { getAiSupportReply } from './ai/aiEngine.js';
import { buildSupportContext } from './ai/contextBuilder.js';
import { understandRequest, understandDeterministicResult, REQUEST_CATEGORIES, REQUEST_ISSUE_TYPES } from './ai/requestExtractor.js';
import { indiaToday, resolveServiceDateIntent } from './ai/serviceDate.js';
import { isOnSiteRequest, ticketRequestCheck } from './ticketRequests.js';
import { createDeviceRegistrationRouter } from './deviceRegistration/deviceRoutes.js';
import { createClaudeColumnMapper } from './deviceRegistration/columnMapper.js';
import { DEVICE_SOURCES, deviceSourceCounts } from './deviceRegistration/deviceSource.js';
import { isPeriod, periodEnded, periodLabel, reviewPeriod, reviewPeriods, startMonthlyReviewScheduler, ticketReviewPeriod } from './monthlyReviews.js';
import { demoEnrollmentDevices } from './demoData.js';
import { createProactiveEngine, createProactiveScheduler, proactiveConfig, ProactiveServiceError } from './services/proactiveService/index.js';
import { createB2CModule } from './b2c/index.js';
import { createAccountRequestRouter } from './accountRequests/accountRequestRoutes.js';
import { parseEmailDomains } from './accountRequests/accountRequestRules.js';
import { createEmailRequestModule } from './emailRequests/emailRequestRoutes.js';
import { createClaudeEmailExtractor } from './emailRequests/emailExtractor.js';
import { createImapMailbox, emailInboxConfig } from './emailRequests/imapMailbox.js';
import { createSmtpSender, createTicketEmailUpdates } from './emailRequests/ticketEmailUpdates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
const googleOAuthDiagnostics = validateGoogleBusinessOauthConfig(getGoogleBusinessOauthConfig());
console.info(`[Google Business] Pub/Sub push authentication configured: ${isPubSubPushConfigured(getPubSubPushConfig())}`);
console.info(`[Google OAuth] Client ID configured: ${googleOAuthDiagnostics.clientIdConfigured}`);
console.info(`[Google OAuth] Client secret configured: ${googleOAuthDiagnostics.clientSecretConfigured}`);
console.info(`[Google OAuth] Redirect URI configured: ${googleOAuthDiagnostics.redirectUriConfigured}`);
console.info(`[Google OAuth] Scope configured: ${googleOAuthDiagnostics.scopeConfigured}`);
if (!googleOAuthDiagnostics.valid) console.error(`[Google OAuth] Missing required configuration: ${googleOAuthDiagnostics.missing.join(', ')}`);
const uploadDir = path.join(__dirname, '../../uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_, file, cb) => cb(null, /^image\//.test(file.mimetype)) });
const AI_SUPPORT_FALLBACK_MESSAGE = 'AI Support is temporarily unavailable. You can continue the request manually or contact the service team.';
const app = express();
// Behind a proxy (Render, a load balancer) set TRUST_PROXY to the number of proxy hops so
// req.ip — used by the sign-up rate limit — is the client address rather than the proxy's.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
// Behind a proxy (e.g. Render), rate limits need the client address it forwards.
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1);
app.use(createCorsMiddleware());
app.use(compression());
app.use(express.json());
app.use('/uploads', express.static(uploadDir));
app.use('/api', restrictB2COnlyStaff);
app.use('/api/ai', auth, createAiSupportRouter());
app.get('/api/health', (_, res) => res.json({ success: true, message: 'API is running' }));
app.use('/api/corporate/devices', createDeviceRegistrationRouter({ models: { Device, Company, ServiceCentre }, auth, allowRoles, suggestColumnMapping: createClaudeColumnMapper() }));
app.use('/api/google-business', createGoogleBusinessRouter({ store: createMongoGoogleBusinessStore({ GoogleBusinessIntegration, GoogleBusinessLocationMapping, GoogleBusinessNotificationReceipt, ServiceCentre, User, Notification }), auth, allowRoles }));
// B2C email escalation management. Separate collections and routes; shares
// accounts, authentication and in-app notifications with the B2B portal.
// With B2C_SEPARATE_SERVER=true it runs only in src/b2cServer.js, so the
// email scheduler never runs in both processes.
const b2cSeparate = process.env.B2C_SEPARATE_SERVER === 'true';
const b2c = b2cSeparate ? null : createB2CModule({ User, Notification, EscalationRule, Device, Customer, notifyUsers, auth });
if (b2c) {
  app.use('/api/b2c/public', b2c.publicRouter);
  app.use('/api/b2c', b2c.router);
  app.use('/api/internal/b2c', b2c.internalRouter);
} else console.info('[B2C] Served by the separate B2C server (B2C_SEPARATE_SERVER=true)');
// Six random digits under the current year; createTicketWithUniqueId retries on the rare collision.
const ticketId = () => `TKT-${new Date().getFullYear()}-${crypto.randomInt(100000, 1000000)}`;
async function createTicketWithUniqueId(fields) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await Ticket.create({ ...fields, ticketId: ticketId() }); }
    catch (error) { if (error?.code !== 11000 || !error.keyPattern?.ticketId || attempt >= 5) throw error; }
  }
}
const serviceAuth = [auth, allowRoles('iplanet_service')];
// Notification centres show the most recent items; older ones stay in the database.
const NOTIFICATION_LIST_LIMIT = 100;
// Fields a corporate user may set when raising a request; everything else on a ticket is server-owned.
const TICKET_REQUEST_FIELDS = ['category', 'issueType', 'description', 'location', 'preferredServiceDate', 'priority', 'deviceCount'];
const transitions = { Open: ['Engineer Assigned'], 'Engineer Assigned': ['Engineer Accepted'], 'Engineer Accepted': ['In Progress'], 'In Progress': ['Waiting for Parts', 'Completed'], 'Waiting for Parts': ['In Progress'], Completed: ['Closed'], Closed: [] };
const escalationContacts = { 1: { level: 1, name: 'Service Coordinator', contactName: 'Neha Menon', email: 'service@iplanet.local' }, 2: { level: 2, name: 'Service Manager', contactName: 'Ravi Shah', email: 'manager@iplanet.local' }, 3: { level: 3, name: 'Regional Operations Manager', contactName: 'Kiran Rao', email: 'operations@iplanet.local' } };
async function notifyUsers({ users, company, ticket, device, type, title, message, serviceCentreId, reviewId, action, priority }) { if (!users.length) return; await Notification.insertMany(users.map(user => ({ user: user._id, company, serviceCentreId, ticket: ticket?._id, device: device?._id, reviewId, portalRole: user.role, type, priority, title, message, action, read: false }))); }
async function serviceUsers() { return User.find({ role: 'iplanet_service' }); }
async function serviceUsersForCentre(serviceCentreId) { return serviceCentreId ? User.find({ role: 'iplanet_service', $or: [{ serviceCentreId }, { serviceCentreId: null }] }) : User.find({ role: 'iplanet_service' }); }
async function getTicketWithContext(ticketIdParam) {
  return Ticket.findById(ticketIdParam).populate('customerId').populate('companyId').populate('serviceCentreId').populate('deviceId').populate('assignedEngineerId');
}
async function callAiProvider(context, priorSteps = [], responseText = '') {
  const userMessage = responseText || context.issueDescription || 'I need help troubleshooting my Apple device.';
  const supportContext = buildSupportContext({ message: userMessage });
  const verifiedTicketContext = [
    `Device type: ${context.deviceType || 'Unknown'}`,
    `Device model: ${context.deviceModel || 'Unknown'}`,
    `Issue category: ${context.issueCategory || 'Unknown'}`,
    `Issue description: ${context.issueDescription || 'Unknown'}`,
    `Ticket ID: ${context.ticketId || 'Unknown'}`,
    `Prior conversation or steps: ${priorSteps.length ? priorSteps.join(' | ').slice(0, 4000) : 'None'}`
  ].join('\n');
  supportContext.portalContext = [supportContext.portalContext, `Verified portal context:\n${verifiedTicketContext}`].filter(Boolean).join('\n\n');
  if (process.env.AI_KNOWLEDGE_DEBUG === 'true') {
    supportContext.retrievedKnowledge.forEach(item => console.info(`AI Knowledge Retrieval: category=${item.category} document=${item.id} score=${item.relevanceScore}`));
  }
  try {
    return { available: true, message: await getAiSupportReply({ message: userMessage, context: supportContext }) };
  } catch (error) {
    console.error(`[AI ERROR] Stage: AI Provider Fallback Code: ${error?.code || 'AI_UNEXPECTED_ERROR'}`);
    return { available: false, message: buildKnowledgeFallbackReply(userMessage) };
  }
}
function buildKnowledgeFallbackReply(message) {
  const knowledge = buildSupportContext({ message }).retrievedKnowledge[0];
  if (!knowledge) return 'I could not reach the AI service, but I can still help. Please describe the device, what changed, and any visible warning or damage.';
  const steps = knowledge.content.split('\n').find(line => line.startsWith('Safe Level-1 steps:'))?.replace('Safe Level-1 steps: ', '');
  const questions = knowledge.content.split('\n').find(line => line.startsWith('Questions to ask:'))?.replace('Questions to ask: ', '');
  return `I could not reach the AI service, so here are safe steps for ${knowledge.title}:\n\n${steps || 'Please try a known-good accessory, restart the device, and install available software updates.'}\n\n${questions || 'Let me know whether the issue continues after these checks.'}`;
}
async function buildAiSession(ticket, session) {
  const issueContext = { ticketId: ticket.ticketId, deviceType: ticket.deviceId?.deviceType || 'Apple device', deviceModel: ticket.deviceId?.model || 'Unknown model', issueCategory: ticket.issueType || 'General support', issueDescription: ticket.description || '', warrantyStatus: ticket.deviceId?.warrantyStatus || 'Unknown', amcStatus: ticket.deviceId?.amcStatus || 'Unknown' };
  const existing = session || (ticket._id ? await AITroubleshootingSession.findOne({ ticketId: ticket._id }).sort({ createdAt: -1 }) : null);
  if (!existing) {
    return AITroubleshootingSession.create({
      ticketId: ticket._id,
      sessionId: `AI-${Date.now()}`,
      issueContext,
      messages: [{ role: 'assistant', content: "Hi! I'm your AI Support Assistant. Tell me what you're experiencing with your device, and I'll help you troubleshoot it step by step.", timestamp: new Date() }],
      troubleshootingSteps: [],
      customerResponses: [],
      result: 'In Progress',
      status: 'In Progress',
      escalationStatus: 'Not Escalated',
      providerAvailable: false,
      providerStatus: 'Pending'
    });
  }
  if (!Array.isArray(existing.messages)) existing.messages = [];
  return existing;
}
function extractAiRequest(reply = '') {
  const match = String(reply).match(/\[\[REQUEST_DATA:(\{.*\})\]\]\s*$/s);
  if (!match) return { reply: String(reply).trim(), requestData: null };
  try {
    const data = JSON.parse(match[1]);
    const categories = ['Service', 'Health Camp', 'Buyback / E-Waste'];
    if (!categories.includes(data.category) || !data.description?.trim()) throw Object.assign(new Error('Invalid AI request data'), { status: 422 });
    return { reply: String(reply).slice(0, match.index).trim(), requestData: data };
  } catch { return { reply: String(reply).replace(match[0], '').trim(), requestData: null }; }
}
function normalizeAiRequest(data, device) {
  if (!data || !device) return null;
  const issueTypes = ['Screen / Display', 'Battery', 'Charging', 'Keyboard', 'Trackpad', 'Camera', 'Speaker', 'Software', 'Performance', 'Physical Damage', 'Other'];
  const issueType = issueTypes.includes(data.issueType) ? data.issueType : 'Other';
  return { deviceId: String(device._id), serialNumber: device.serialNumber, deviceName: device.model, category: data.category, issueType, description: data.description.trim().slice(0, 4000), location: data.location?.trim() || device.location || '', preferredServiceDate: resolveServiceDateIntent(data.preferredServiceDate).date || indiaToday(), coverage: { warrantyStatus: device.warrantyStatus, warrantyExpiry: device.warrantyExpiry, amcStatus: device.amcStatus, amcExpiry: device.amcExpiry }, employee: { name: device.employeeName, id: device.employeeId, department: device.department } };
}
function escapeRegex(value = '') { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function findAuthorizedDeviceBySerial(serialNumber, companyId) {
  const serial = String(serialNumber || '').trim();
  if (!serial || serial.length < 4) return null;
  return Device.findOne({ serialNumber: { $regex: `^${escapeRegex(serial)}$`, $options: 'i' }, companyId });
}
function serialMention(message = '') {
  // A serial is intentionally only a candidate. It is always checked against the caller's company inventory.
  // Serials are written in capitals and mix letters with digits, which rules out ordinary words
  // ("built-in"), dates, phone numbers and model names such as "iPhone15".
  return String(message).split(/\s+/).map(value => value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''))
    .find(value => /^[A-Z0-9-]{6,20}$/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value)) || null;
}
async function authoritativeServiceLocation(device) {
  if (device?.location?.trim()) return device.location.trim();
  const company = device?.companyId ? await Company.findById(device.companyId).select('location') : null;
  return company?.location?.trim() || '';
}
async function validatedRequestDraft(state, device) {
  if (!device || !state.description) return null;
  const location = await authoritativeServiceLocation(device);
  if (!location) return null;
  return {
    deviceId: String(device._id), serialNumber: device.serialNumber, deviceName: device.model,
    category: REQUEST_CATEGORIES.includes(state.category) ? state.category : 'Service',
    issueType: REQUEST_ISSUE_TYPES.includes(state.issueType) ? state.issueType : 'Other',
    description: String(state.description).trim().slice(0, 4000),
    // Location is always loaded from MongoDB, never accepted from the model or chat text.
    // A missing preference defaults to today's India calendar date. This is a date-only string.
    location, preferredServiceDate: state.preferredServiceDate || indiaToday(),
    coverage: { warrantyStatus: device.warrantyStatus, warrantyExpiry: device.warrantyExpiry, amcStatus: device.amcStatus, amcExpiry: device.amcExpiry },
    employee: { name: device.employeeName, id: device.employeeId, department: device.department }
  };
}
// "Service Recommended" is also the iPhone/Mac battery-condition wording; that is a fault report, not a schedule question.
const BATTERY_SERVICE_STATUS = /\b(battery|condition|health)\b[^.?!]*\bservice recommended\b|\bservice recommended\b[^.?!]*\bbattery\b/i;
const isProactiveServiceQuestion = message => PROACTIVE_SERVICE_QUESTION.test(message) && !BATTERY_SERVICE_STATUS.test(message);
const PROACTIVE_SERVICE_QUESTION = /\b(service recommended|recommended service|preventive|preventative|maintenance|service (?:is )?due|due for (?:a )?service|next service|service reminder|routine service|periodic service)\b/i;
// Date-only strings are calendar days; stored dates are shown in the business time zone.
const displayDay = value => {
  if (!value) return 'not on record';
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = dateOnly ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return 'not on record';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: dateOnly ? 'UTC' : proactiveConfig.timeZone }).format(date);
};
const whenText = days => (days === null || days === undefined ? '' : days > 0 ? ` (in ${days} day${days === 1 ? '' : 's'})` : days === 0 ? ' (today)' : ` (${-days} day${days === -1 ? '' : 's'} ago)`);
const coverageText = coverage => [`Warranty: ${coverage.warrantyStatus || 'not on record'}${coverage.warrantyExpiry ? `, ends ${displayDay(coverage.warrantyExpiry)}` : ''}`, `AMC: ${coverage.amcStatus || 'not on record'}${coverage.amcExpiry ? `, ends ${displayDay(coverage.amcExpiry)}` : ''}`].join('. ');
// Plain-language summary of preventive-service status built only from engine data.
function proactiveServiceReply({ device, items, plan }) {
  if (items.length === 1) {
    const item = items[0];
    const stageLine = item.stage === 'Scheduled' ? ` iPlanet Service has scheduled it for ${displayDay(item.scheduledDate)}.`
      : item.stage === 'Remind Later' ? ` A reminder is set for ${displayDay(item.followUpDate)}.`
      : item.stage === 'Contacted' ? ' iPlanet Service has already been in touch with your team about it.'
      : item.stage === 'In Service' ? ' It is already with iPlanet Service under an open service request.' : '';
    const offer = item.stage === 'In Service' ? '' : ' If you would like it serviced, I can open the service request form with these details filled in. Nothing is submitted until you review and confirm it.';
    return `Your ${item.device.model} (${item.device.serialNumber}) is ${item.status === 'Upcoming' ? 'coming up for' : item.status === 'Overdue' ? 'overdue for' : 'due for'} preventive service. Last service: ${displayDay(item.lastServiceDate)}. Recommended service date: ${displayDay(item.nextServiceDate)}${whenText(item.daysUntil)}. ${coverageText(item.coverage)}.${stageLine}${offer}`;
  }
  if (items.length > 1) {
    const lines = items.slice(0, 5).map(item => `• ${item.device.model} (${item.device.serialNumber}): ${item.status}, recommended ${displayDay(item.nextServiceDate)}`);
    return `${items.length} of your devices have preventive service recommended:\n${lines.join('\n')}\nChoose a device below to open a pre-filled service request for review, or tell me its serial number.`;
  }
  if (plan?.nextServiceDate) return `Your ${plan.device.model} (${plan.device.serialNumber}) is not due for preventive service yet. Last service: ${displayDay(plan.lastServiceDate)}. Next recommended service: ${displayDay(plan.nextServiceDate)}${whenText(plan.daysUntil)}. ${coverageText(plan.coverage)}.`;
  if (plan) return `I don't have enough purchase or service history for your ${plan.device.model} to recommend a service date. iPlanet Service can set one up for you.`;
  if (device) return `I couldn't find service information for your ${device.model}.`;
  return 'None of your devices has preventive service recommended right now.';
}
async function findDeviceMentionedInMessage(message, companyId) {
  const devices = await Device.find({ companyId }).limit(100);
  const normalizedMessage = String(message || '').toLowerCase();
  return devices.find(device => device.serialNumber && normalizedMessage.includes(String(device.serialNumber).toLowerCase())) || null;
}
function sanitizePhone(phone = '') {
  const digits = String(phone).replace(/\D/g, '');
  return digits ? `tel:+${digits}` : '';
}
function formatCustomerPhone(phone = '') {
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return 'Not available';
  return `+${digits}`;
}
function toTicketSummary(ticket) {
  const customer = ticket.customerId || {};
  const device = ticket.deviceId || {};
  return { customerName: customer.name || customer.company || 'Customer', customerCompany: customer.company || ticket.companyId?.name || 'Customer company', customerPhone: customer.phone || ticket.companyId?.phone || '', phoneHref: sanitizePhone(customer.phone || ticket.companyId?.phone || ''), ticketId: ticket.ticketId, issueType: ticket.issueType, description: ticket.description, deviceModel: device.model || 'Unknown device', serialNumber: device.serialNumber || 'Unknown', companyName: ticket.companyId?.name || customer.company || 'Company', deviceType: device.deviceType || 'Apple Device' };
}
// Active escalation rules change rarely but are read for every ticket in every
// list, so they are cached briefly and the cache is dropped whenever a rule changes.
const ESCALATION_RULE_TTL_MS = 30000;
// The pending query is cached (not just its result) so the many tickets
// evaluated in one request share a single rules lookup.
let escalationRuleCache = { at: 0, rules: null };
function activeEscalationRules() {
  if (!escalationRuleCache.rules || Date.now() - escalationRuleCache.at > ESCALATION_RULE_TTL_MS) {
    const rules = EscalationRule.find({ isActive: true }).sort({ slaThreshold: -1 }).lean().exec();
    escalationRuleCache = { at: Date.now(), rules };
    rules.catch(() => { if (escalationRuleCache.rules === rules) escalationRuleCache = { at: 0, rules: null }; });
  }
  return escalationRuleCache.rules;
}
const clearEscalationRuleCache = () => { escalationRuleCache = { at: 0, rules: null }; };
// The calculation lives in slaEscalation.js so B2C escalations follow the same rules.
async function evaluateEscalation(ticket, createEvents = false) {
  if (!ticket.slaTargetAt || ['Completed', 'Closed'].includes(ticket.status)) return ticket;
  const escalation = computeSlaEscalation(ticket, await activeEscalationRules());
  if (!escalation) return ticket;
  const { update, nextStatus, level, reason, changed } = escalation;
  // Several requests can evaluate the same ticket at once (dashboard + list, two users). The write is
  // conditional on the state this request read, so only the request whose write lands emits events.
  const result = await Ticket.updateOne({ _id: ticket._id, slaStatus: ticket.slaStatus ?? null, escalationStatus: ticket.escalationStatus ?? null, escalationLevel: ticket.escalationLevel ?? null }, { $set: update });
  if (typeof ticket.set === 'function') ticket.set(update); else Object.assign(ticket, update);
  if (changed && createEvents && result.modifiedCount === 1) {
    await TicketTimeline.create({ ticketId: ticket._id, status: nextStatus, message: `${reason}. Escalated to Level ${level}.`, updatedBy: 'SLA Monitor', userRole: 'iplanet_service' });
    const users = await serviceUsers();
    await notifyUsers({ users, company: ticket.companyId, serviceCentreId: ticket.serviceCentreId, ticket, type: 'SLA_ESCALATION', title: nextStatus === 'SLA Breached' ? 'SLA breached' : 'SLA approaching', message: `Ticket ${ticket.ticketId} is ${nextStatus.toLowerCase()}. ${reason}.` });
    const admins = await User.find({ role: 'corporate_admin', companyId: ticket.companyId });
    await notifyUsers({ users: admins, company: ticket.companyId, ticket, type: 'SLA_ESCALATION', title: `SLA update for ${ticket.ticketId}`, message: `${ticket.ticketId} is ${nextStatus.toLowerCase()}. ${reason}.` });
  }
  return ticket;
}

app.post('/api/auth/login', async (req, res) => {
  // The password is excluded from every other query (select: false), so it is requested explicitly here.
  // Only plain strings are accepted, so query operators such as {"$gt": ""} can't select an arbitrary account.
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return res.status(400).json({ message: 'Email and password are required' });
  const user = await User.findOne({ email: email.trim() }).select('+password');
  if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ message: 'Invalid demo credentials' });
  if (needsRehash(user.password)) await User.updateOne({ _id: user._id }, { password: hashPassword(password) });
  const token = jwt.sign({ id: user._id, name: user.name, email: user.email, role: user.role, companyId: user.companyId, serviceCentreId: user.serviceCentreId }, jwtSecret(), { expiresIn: '8h' });
  // b2cRole only controls which navigation the portal shows; the B2C API re-reads it from the database on every request.
  res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, company: user.company, companyId: user.companyId, serviceCentreId: user.serviceCentreId, b2cRole: user.b2cRole || null } });
});

const corporateCompany = req => req.user.role === 'corporate_admin' ? { companyId: new mongoose.Types.ObjectId(req.user.companyId) } : {};
app.get('/api/devices', auth, allowRoles('corporate_admin'), async (req, res) => { const query = { ...corporateCompany(req), ...(req.query.search ? { $or: ['assetId', 'serialNumber', 'model', 'employeeName', 'location'].map(field => ({ [field]: { $regex: escapeRegex(String(req.query.search)), $options: 'i' } })) } : {}) }; res.json(await Device.find(query).populate('companyId').sort({ assetId: 1 })); });
app.get('/api/devices/serial/:serialNumber', auth, allowRoles('corporate_admin'), async (req, res) => { const device = await Device.findOne({ serialNumber: req.params.serialNumber, ...corporateCompany(req) }); if (!device) return res.status(404).json({ message: 'No device found for that serial number' }); res.json(device); });
app.get('/api/devices/:id', auth, allowRoles('corporate_admin'), async (req, res) => { const device = await Device.findOne({ _id: req.params.id, ...corporateCompany(req) }); if (!device) return res.status(404).json({ message: 'Device not found' }); res.json(device); });
app.get('/api/tickets', auth, allowRoles('corporate_admin'), async (req, res) => { const query = { companyId: req.user.companyId, ...(req.query.status && req.query.status !== 'All' ? { status: req.query.status } : {}) }; const tickets = await Ticket.find(query).populate('deviceId').populate('companyId', 'name companyId location').populate('assignedEngineerId', 'name employeeId phone email location status').sort({ createdAt: -1 }); await Promise.all(tickets.map(ticket => evaluateEscalation(ticket, true))); res.json(tickets); });
// What was done to resolve each of the organization's completed or closed requests, for reports:
// the latest Completed note (the Closed note if there is none), with when it was recorded.
app.get('/api/tickets/resolutions', auth, allowRoles('corporate_admin'), async (req, res) => {
  const tickets = await Ticket.find({ companyId: req.user.companyId, status: { $in: ['Completed', 'Closed'] } }).select('_id').lean();
  const entries = await TicketTimeline.find({ ticketId: { $in: tickets.map(ticket => ticket._id) }, status: { $in: ['Completed', 'Closed'] } }).sort({ timestamp: -1 }).lean();
  const resolutions = {};
  for (const entry of entries) {
    const id = String(entry.ticketId);
    const current = resolutions[id];
    if (!current || (current.status === 'Closed' && entry.status === 'Completed')) resolutions[id] = { status: entry.status, resolution: [entry.message, entry.note].filter(Boolean).join(' '), recordedAt: entry.timestamp };
  }
  res.json(resolutions);
});
app.get('/api/tickets/:id', auth, allowRoles('corporate_admin'), async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }).populate('deviceId').populate('companyId').populate('serviceCentreId').populate('assignedEngineerId').populate('customerId'); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); await evaluateEscalation(ticket, true); const [timeline, callHistory, aiSupport, review] = await Promise.all([TicketTimeline.find({ ticketId: ticket._id }).sort({ timestamp: 1 }), CallRecord.find({ ticketId: ticket._id }).sort({ createdAt: -1 }), AITroubleshootingSession.find({ ticketId: ticket._id }).sort({ createdAt: -1 }), Review.findOne({ ticketId: ticket._id })]); const reviewPeriodKey = await ticketReviewPeriod(reviewModels, ticket); const monthReview = !review && reviewPeriodKey ? await Review.findOne({ corporateId: ticket.companyId?._id || ticket.companyId, period: reviewPeriodKey }) : null; const reviewSubmitted = Boolean(review || monthReview); const reviewEligible = Boolean(reviewPeriodKey) && periodEnded(reviewPeriodKey) && !reviewSubmitted; res.json({ ticket, reviewEligible, reviewSubmitted, reviewId: (review || monthReview)?._id || null, reviewPeriod: reviewPeriodKey ? { period: reviewPeriodKey, label: periodLabel(reviewPeriodKey), ended: periodEnded(reviewPeriodKey) } : null, escalation: { status: ticket.escalationStatus, level: ticket.escalationLevel, reason: ticket.escalationReason, responseTarget: ticket.responseTarget, resolutionTarget: ticket.resolutionTarget, slaTargetAt: ticket.slaTargetAt }, escalationContact: escalationContacts[ticket.escalationLevel] || null, timeline, callHistory, aiSupport }); });
// Service requests are for one of the organization's devices; on-site requests (Health Camp,
// Buyback / E-Waste) are for a batch and carry no device.
app.post('/api/tickets', auth, allowRoles('corporate_admin'), async (req, res) => { const check = ticketRequestCheck(req.body, indiaToday()); if (check.error) return res.status(400).json({ message: check.error }); const device = check.deviceId ? await Device.findOne({ _id: check.deviceId, companyId: req.user.companyId }) : null; if (check.deviceId && !device) return res.status(400).json({ message: 'Valid company device selection is required' }); let followUp = null; if (device) try { followUp = await proactiveEngine.validateTicketLink(req.body.serviceFollowUpId, { companyId: req.user.companyId, deviceId: device._id }); } catch (error) { return res.status(error.status || 400).json({ message: error.message }); } const requestFields = Object.fromEntries(TICKET_REQUEST_FIELDS.filter(field => req.body[field] !== undefined).map(field => [field, req.body[field]])); if (isOnSiteRequest(requestFields.category)) requestFields.deviceCount = Number(requestFields.deviceCount); else delete requestFields.deviceCount; const createdAt = new Date(); const ticket = await createTicketWithUniqueId({ ...requestFields, serviceFollowUpId: followUp?._id, ...(followUp?.serviceCentreId ? { serviceCentreId: followUp.serviceCentreId } : {}), customerId: req.user.id, companyId: req.user.companyId, deviceId: device?._id, status: 'Open', images: [], originalImages: [], annotatedImages: [], responseTarget: '4 business hours', resolutionTarget: `${targetHours(req.body.priority)} hours`, slaTargetAt: new Date(createdAt.getTime() + targetHours(req.body.priority) * 3600000), slaStatus: 'Healthy', escalationStatus: 'Not Escalated' }); await TicketTimeline.create({ ticketId: ticket._id, status: 'Open', message: followUp ? 'Service request created by Corporate Admin from a preventive service recommendation.' : 'Service request created by Corporate Admin.', updatedBy: 'Corporate Portal', userRole: 'corporate_admin' }); if (followUp) await proactiveEngine.linkTicket(followUp, ticket, req.user); const users = await serviceUsers(); await notifyUsers({ users, company: ticket.companyId, ticket, device, type: 'NEW_SERVICE_REQUEST', title: 'New service request', message: device ? `${ticket.ticketId} was raised for ${device.model}.` : `${ticket.ticketId} was raised for a ${ticket.category} visit (${ticket.deviceCount} devices).` }); res.status(201).json(await ticket.populate('deviceId')); });
app.post('/api/tickets/:id/images', auth, allowRoles('corporate_admin'), upload.array('images', 5), async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); if (!req.files?.length) return res.status(400).json({ message: 'Attach at least one image.' }); const paths = req.files.map(file => `/uploads/${file.filename}`); ticket.images.push(...paths); ticket.originalImages.push(...paths); await ticket.save(); res.json(ticket); });
app.post('/api/tickets/:id/annotated-images', auth, allowRoles('corporate_admin'), upload.array('images', 5), async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); if (!req.files?.length) return res.status(400).json({ message: 'Attach at least one image.' }); const paths = req.files.map(file => `/uploads/${file.filename}`); ticket.images.push(...paths); ticket.annotatedImages.push(...paths); await ticket.save(); res.json(ticket); });
app.get('/api/tickets/:id/calls', auth, allowRoles('corporate_admin'), async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }).populate('customerId'); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); res.json(await CallRecord.find({ ticketId: ticket._id }).sort({ createdAt: -1 })); });
app.get('/api/tickets/:id/ai-support', auth, async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }).populate('deviceId'); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); const session = await AITroubleshootingSession.findOne({ ticketId: ticket._id }).sort({ createdAt: -1 }); res.json({ session, sessionId: session?._id || null, hasAttempted: !!session }); });
app.post('/api/tickets/:id/ai-support', auth, async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }).populate('deviceId'); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); const session = await buildAiSession(ticket, await AITroubleshootingSession.findOne({ ticketId: ticket._id }).sort({ createdAt: -1 })); const previousSteps = session.troubleshootingSteps.map(step => step.step);
  if (req.body.customerResponse) {
    session.customerResponses.push({ response: req.body.customerResponse, timestamp: new Date() });
  }
  if (req.body.stepResult) {
    session.troubleshootingSteps.push({ step: req.body.stepLabel || 'Troubleshooting step', outcome: req.body.stepResult, timestamp: new Date() });
  }
  const aiPayload = { ticket, previousSteps, customerResponse: req.body.customerResponse || '' };
  try {
    const result = await callAiProvider({ deviceType: ticket.deviceId?.deviceType || 'Apple device', deviceModel: ticket.deviceId?.model || 'Unknown model', issueCategory: ticket.issueType || 'General support', issueDescription: ticket.description || '', ticketId: ticket.ticketId }, previousSteps, req.body.customerResponse || '');
    session.providerAvailable = result.available;
    session.providerStatus = result.available ? 'Available' : 'Unavailable';
    session.result = req.body.resolved ? 'Resolved' : session.result;
    session.escalationStatus = req.body.resolved ? 'Resolved' : session.escalationStatus;
    if (result.available) {
      session.troubleshootingSteps.push({ step: result.message, outcome: req.body.customerResponse ? 'Awaiting customer confirmation' : 'Next step suggested', timestamp: new Date() });
    }
    await session.save();
    res.json({ session, available: result.available, message: result.message });
  } catch (error) {
    console.error(`[AI ERROR] Stage: Ticket AI Support Code: ${error.code || 'AI_UNEXPECTED_ERROR'}`);
    session.providerAvailable = false;
    session.providerStatus = 'Unavailable';
    session.result = 'AI unavailable';
    await session.save();
    res.status(200).json({ success: false, message: AI_SUPPORT_FALLBACK_MESSAGE, session });
  }
});
app.post('/api/ai/support/chat', auth, async (req, res) => {
  const { message, conversationId, ticketId, deviceId } = req.body || {};
  const trimmedMessage = String(message || '').trim();
  if (!trimmedMessage) return res.status(400).json({ message: 'A message is required.' });
  if (trimmedMessage.length > 4000) return res.status(400).json({ message: 'Message must be 4000 characters or fewer.' });
  if (req.user.role !== 'corporate_admin') return res.status(403).json({ message: 'This account is not allowed to access AI support.' });

  if (ticketId && !mongoose.isValidObjectId(ticketId)) return res.status(404).json({ message: 'Ticket not found' });
  if (deviceId && !mongoose.isValidObjectId(deviceId)) return res.status(404).json({ message: 'Device not found' });
  const ticket = ticketId ? await Ticket.findOne({ _id: ticketId, companyId: req.user.companyId }).populate('deviceId') : null;
  if (ticketId && !ticket) return res.status(404).json({ message: 'Ticket not found' });
  const suppliedSerial = !ticket && !deviceId ? serialMention(trimmedMessage) : null;
  const device = ticket?.deviceId || (deviceId ? await Device.findOne({ _id: deviceId, companyId: req.user.companyId }) : await findAuthorizedDeviceBySerial(suppliedSerial, req.user.companyId));
  if (deviceId && !device) return res.status(404).json({ message: 'Device not found' });

  // A missing conversation ID means the customer deliberately started a new
  // chat. Never query MongoDB with an undefined session ID: it can otherwise
  // match legacy documents and resume a later state such as device collection.
  const session = ticketId
    // The client sends back the conversationId it was given, which is the session's sessionId string.
    ? (conversationId ? await AITroubleshootingSession.findOne({ sessionId: String(conversationId), ticketId: ticket._id }) : await AITroubleshootingSession.findOne({ ticketId: ticket._id }).sort({ createdAt: -1 }))
    : (conversationId ? await AITroubleshootingSession.findOne({ sessionId: conversationId, customerId: req.user.id }) : null);

  const activeSession = session || await buildAiSession(ticket || { ticketId: 'Unknown', deviceId: device || {} }, null);
  activeSession.customerId = req.user.id;
  if (device) activeSession.deviceId = device._id;
  if (ticket && String(activeSession.ticketId) !== String(ticket._id)) {
    activeSession.ticketId = ticket._id;
  }

  activeSession.messages = Array.isArray(activeSession.messages) ? activeSession.messages : [];
  activeSession.messages.push({ role: 'user', content: trimmedMessage, timestamp: new Date() });

  // Existing-ticket conversations remain support-only; never turn an existing ticket into a new request.
  if (!ticket) {
    if (suppliedSerial && !device) {
      const reply = "I couldn't find that device. Please check the serial number and try again.";
      activeSession.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
      await activeSession.save();
      return res.json({ success: true, message: reply, conversationId: activeSession.sessionId, session: activeSession });
    }
    // Preventive-service questions are answered from the proactive-service
    // engine, the same source the portals use. The reply can only offer to
    // open a pre-filled Raise Request; it never creates a ticket itself.
    if (isProactiveServiceQuestion(trimmedMessage)) {
      const scope = { companyId: req.user.companyId };
      const { items } = await proactiveEngine.list({ scope });
      // Without a named device, only list recommendations the customer can still act on.
      const relevant = device ? items.filter(item => item.deviceId === String(device._id)) : items.filter(item => item.stage !== 'In Service');
      const plan = device && !relevant.length ? await proactiveEngine.devicePlan(device._id, scope) : null;
      const reply = proactiveServiceReply({ device, items: relevant, plan });
      const serviceRecommendations = relevant.filter(item => item._id && ['Open', 'Contacted', 'Remind Later', 'Scheduled'].includes(item.stage)).slice(0, 3)
        .map(item => ({ followUpId: item._id, deviceId: item.deviceId, deviceName: item.device.model, serialNumber: item.device.serialNumber, status: item.status, nextServiceDate: item.nextServiceDate }));
      activeSession.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
      await activeSession.save();
      return res.json({ success: true, message: reply, conversationId: activeSession.sessionId, session: activeSession, serviceRecommendations });
    }
    const currentFlow = activeSession.issueContext?.flowState || 'initial';
    let pendingDraft = null;
    try {
      const deterministicResult = understandDeterministicResult(trimmedMessage);
      // Do not consume a cloud request merely to classify an unmistakable
      // answer to the preceding troubleshooting question. Gemini remains the
      // response generator for the initial/ongoing troubleshooting turn.
      const useDeterministicUnderstanding = currentFlow === 'initial'
        // A clear answer to the previous troubleshooting question needs no
        // cloud classification. This prevents a second Gemini call per turn.
        || (currentFlow === 'awaiting_troubleshooting_result'
          && ['resolved', 'failed'].includes(deterministicResult.workflowSignal));
      const understanding = useDeterministicUnderstanding
        ? deterministicResult
        : await understandRequest({ message: trimmedMessage, conversation: activeSession.messages.slice(0, -1) });
      const previous = activeSession.issueContext?.requestDraft || {};
      const state = {
        category: previous.category || understanding.category || 'Service',
        issueType: previous.issueType || understanding.issueType || null,
        description: previous.description || understanding.description || null,
        // A date the customer gives now replaces an earlier one ("make it Thursday instead").
        preferredServiceDate: resolveServiceDateIntent(understanding.preferredServiceDateIntent || trimmedMessage).date || previous.preferredServiceDate || null,
        symptoms: [...new Set([...(previous.symptoms || []), ...(understanding.symptoms || [])])]
      };
      if (device) state.deviceId = String(device._id);
      pendingDraft = state;
      const dateResolution = resolveServiceDateIntent(understanding.preferredServiceDateIntent || trimmedMessage);
      // A report may naturally include words such as "still" on its first turn.
      // That must never bypass the required L1 troubleshooting cycle. A failed
      // result only advances the flow after the application has asked the user
      // to try the supplied steps. Immediate service and safety signals are the
      // deliberately limited exceptions.
      const troubleshootingFailed = currentFlow === 'awaiting_troubleshooting_result'
        && understanding.workflowSignal === 'failed';
      const directServiceRequired = ['explicit_service', 'unsafe'].includes(understanding.workflowSignal);
      const shouldPrepareRequest = ['device_identification', 'collecting_request_details'].includes(currentFlow)
        || troubleshootingFailed || directServiceRequired;
      let flowState = currentFlow;
      let reply;
      let draft = null;
      let ratingRequested = false;

      if (currentFlow === 'awaiting_troubleshooting_result' && understanding.workflowSignal === 'resolved') {
        flowState = 'completed';
        // The customer confirmed the supplied steps fixed the issue. Ask for a
        // rating once per session; later resolutions keep the plain reply.
        ratingRequested = !activeSession.feedback?.promptedAt;
        if (ratingRequested) activeSession.set('feedback.promptedAt', new Date());
        reply = ratingRequested
          ? 'Glad that helped. How was your experience?'
          : "Great! I'm glad that fixed the issue. If you need anything else, I'm here to help.";
      } else if (shouldPrepareRequest) {
        flowState = device ? 'collecting_request_details' : 'device_identification';
        draft = !dateResolution.ambiguous && device ? await validatedRequestDraft(state, device) : null;
        if (draft) flowState = 'ready_for_review';
        reply = understanding.workflowSignal === 'unsafe'
          ? 'Please stop using the device and disconnect it from power if it is safe to do so. This needs service attention.'
          : 'Since the issue is still occurring, I can help you raise a service request.';
        if (!device) reply += ' Please provide the serial number of the affected device.';
        else if (dateResolution.ambiguous) reply += ' What exact date would you prefer for service?';
        else if (!draft?.location) reply += ' Please select the service location when reviewing the request.';
        else if (draft) reply += ` I have prepared a request for your ${device.model}. Review the details before submitting it.`;
      } else if (currentFlow === 'awaiting_troubleshooting_result') {
        // Keep the same troubleshooting turn active instead of repeating its full step list.
        flowState = 'awaiting_troubleshooting_result';
        reply = 'Please continue with the remaining safe troubleshooting steps and let me know whether the issue is resolved or still happening.';
      } else {
        // A first technical report always gets L1 guidance before device collection.
        const supportContext = buildSupportContext({ message: trimmedMessage, conversation: activeSession.messages.slice(0, -1) });
        supportContext.portalContext = `${supportContext.portalContext || ''}\nNew-request flow: provide safe Level-1 troubleshooting only. Do not ask for a serial number or offer to create a request yet; end by asking whether the issue is resolved.`.trim();
        reply = await getAiSupportReply({ message: trimmedMessage, context: supportContext });
        flowState = 'awaiting_troubleshooting_result';
      }
      const missingFields = [];
      if (flowState === 'device_identification') missingFields.push('serialNumber');
      if (!state.description) missingFields.push('description');
      if (device && !draft?.location) missingFields.push('location');
      activeSession.issueContext = { ...activeSession.issueContext, flowState, requestDraft: state, missingFields, intent: understanding.intent, troubleshooting: { stepsProvided: flowState === 'awaiting_troubleshooting_result' || currentFlow === 'awaiting_troubleshooting_result', resolved: flowState === 'completed' ? true : null } };
      activeSession.providerAvailable = true;
      activeSession.providerStatus = 'Available';
      activeSession.status = flowState === 'ready_for_review' ? 'Request ready for review' : flowState === 'completed' ? 'Resolved' : 'In Progress';
      if (draft) {
        activeSession.preparedRequest = draft;
        activeSession.escalationStatus = 'Recommended Service Assistance';
      }
      activeSession.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
      await activeSession.save();
      return res.json({ success: true, message: reply, conversationId: activeSession.sessionId, session: activeSession, requestData: draft ? { ...draft, conversationId: activeSession.sessionId } : null, ratingRequested });
    } catch (error) {
      console.error(`[AI ERROR] Stage: Request Understanding Code: ${error.code || 'AI_UNEXPECTED_ERROR'}`);
      activeSession.providerAvailable = false;
      activeSession.providerStatus = 'Unavailable';
      activeSession.status = 'In Progress';
      const reply = buildKnowledgeFallbackReply(trimmedMessage);
      // The fallback still gives safe Level-1 steps for a recognised issue. Record
      // that like the normal path does, so the customer's next answer (resolved or
      // still failing) is handled by the troubleshooting flow instead of being
      // treated as a brand-new issue.
      const fallbackStepsGiven = Boolean(buildSupportContext({ message: trimmedMessage }).retrievedKnowledge[0]);
      if (fallbackStepsGiven && ['initial', 'completed'].includes(currentFlow)) {
        activeSession.issueContext = { ...activeSession.issueContext, flowState: 'awaiting_troubleshooting_result', ...(pendingDraft ? { requestDraft: pendingDraft } : {}), troubleshooting: { stepsProvided: true, resolved: null } };
      }
      activeSession.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
      await activeSession.save();
      return res.json({ success: true, message: reply, conversationId: activeSession.sessionId, session: activeSession });
    }
  }
  const conversationHistory = activeSession.messages.map(item => `${item.role === 'user' ? 'Customer' : 'Assistant'}: ${item.content}`).slice(-12);

  try {
    const result = await callAiProvider({
      deviceType: device?.deviceType || 'Apple device',
      deviceModel: device?.model || 'Unknown model',
      issueCategory: ticket?.issueType || 'General support',
      issueDescription: ticket?.description || 'No existing issue details provided',
      ticketId: ticket?.ticketId || activeSession.issueContext?.ticketId || 'Unknown'
    }, conversationHistory, trimmedMessage);

    activeSession.providerAvailable = result.available;
    activeSession.providerStatus = result.available ? 'Available' : 'Unavailable';
    activeSession.status = 'In Progress';
    const { reply: cleanReply, requestData: aiRequest } = extractAiRequest(result.message);
    activeSession.messages.push({ role: 'assistant', content: cleanReply, timestamp: new Date() });
    const requestData = !ticket ? normalizeAiRequest(aiRequest, device) : null;
    if (requestData) { activeSession.preparedRequest = requestData; activeSession.escalationStatus = 'Recommended Service Assistance'; activeSession.status = 'Request ready for review'; }
    await activeSession.save();
    const formRequestData = requestData ? { ...requestData, conversationId: activeSession.sessionId } : null;
    res.json({ success: true, message: requestData ? `${cleanReply}\n\nI prepared your service request for review.` : cleanReply, conversationId: activeSession.sessionId || String(activeSession._id), session: activeSession, requestData: formRequestData });
  } catch (error) {
    console.error(`[AI ERROR] Stage: AI Support Chat Code: ${error.code || 'AI_UNEXPECTED_ERROR'}`);
    activeSession.providerAvailable = false;
    activeSession.providerStatus = 'Unavailable';
    activeSession.status = 'AI unavailable';
    await activeSession.save();
    res.status(200).json({
      success: false,
      message: AI_SUPPORT_FALLBACK_MESSAGE,
      conversationId: activeSession.sessionId || String(activeSession._id),
      session: activeSession
    });
  }
});
// Rating for an AI Support session the customer confirmed as resolved. No
// ticket exists in that flow, so the feedback is stored on the session itself
// and the service team is notified through the existing notification system.
app.post('/api/ai/support/feedback/:conversationId', auth, allowRoles('corporate_admin'), async (req, res) => {
  const { rating, comment } = req.body || {};
  const cleanComment = String(comment || '').trim();
  if (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5) return res.status(400).json({ message: 'Rating must be an integer from 1 to 5.' });
  if (cleanComment.length > 2000) return res.status(400).json({ message: 'Feedback must be 2000 characters or fewer.' });
  const session = await AITroubleshootingSession.findOne({ sessionId: req.params.conversationId, customerId: req.user.id }).populate('deviceId');
  if (!session) return res.status(404).json({ message: 'AI Support conversation not found.' });
  // promptedAt is only ever set when the customer confirmed resolution.
  if (!session.feedback?.promptedAt) return res.status(400).json({ message: 'Feedback can be shared once the issue is resolved.' });
  if (session.feedback?.submittedAt) return res.status(409).json({ message: 'Feedback has already been submitted for this conversation.' });
  session.set({ 'feedback.rating': Number(rating), 'feedback.comment': cleanComment || undefined, 'feedback.submittedAt': new Date() });
  await session.save();
  const device = session.deviceId && typeof session.deviceId === 'object' ? session.deviceId : null;
  await notifyUsers({ users: await serviceUsers(), company: req.user.companyId, device, type: 'AI_SUPPORT_FEEDBACK', title: 'AI Support feedback', message: `A customer rated AI Support ${Number(rating)}/5 after resolving${device?.model ? ` a ${device.model}` : ' an'} issue.${cleanComment ? ` "${cleanComment.slice(0, 160)}"` : ''}` });
  return res.status(201).json({ feedback: session.feedback });
});
app.get('/api/ai/support/request-data/:conversationId', auth, async (req, res) => {
  const session = await AITroubleshootingSession.findOne({ sessionId: req.params.conversationId, customerId: req.user.id });
  if (!session?.preparedRequest) return res.status(404).json({ message: 'No prepared AI request was found.' });
  const device = await Device.findOne({ _id: session.preparedRequest.deviceId, companyId: req.user.companyId });
  if (!device) return res.status(404).json({ message: 'The prepared device is no longer available.' });
  return res.json({ requestData: normalizeAiRequest(session.preparedRequest, device) });
});
app.get('/api/dashboard/stats', auth, allowRoles('corporate_admin'), async (req, res) => { const [sources, tickets, warrantyDevices, amcDevices] = await Promise.all([deviceSourceCounts(Device, corporateCompany(req)), Ticket.find(corporateCompany(req)), Device.countDocuments({ ...corporateCompany(req), warrantyStatus: 'Active' }), Device.countDocuments({ ...corporateCompany(req), amcStatus: 'Active' })]); await Promise.all(tickets.map(ticket => evaluateEscalation(ticket, true))); res.json({ totalDevices: sources.total, iplanetDevices: sources.iplanet, otherDevices: sources.other, openTickets: tickets.filter(t => t.status === 'Open').length, inProgress: tickets.filter(t => t.status === 'In Progress').length, completedTickets: tickets.filter(t => t.status === 'Completed').length, closedTickets: tickets.filter(t => t.status === 'Closed').length, activeEscalations: tickets.filter(t => t.escalationStatus === 'Escalated').length, atRiskTickets: tickets.filter(t => t.escalationStatus === 'At Risk').length, breachedTickets: tickets.filter(t => t.escalationStatus === 'SLA Breached').length, warrantyDevices, amcDevices }); });
// Tickets per month of the current year, counted in India time so a ticket raised
// just after midnight IST on the 1st lands in the right month.
async function ticketVolumeByMonth(match = {}) {
  const timezone = 'Asia/Kolkata';
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric' }).format(new Date()));
  const rows = await Ticket.aggregate([{ $match: match }, { $project: { year: { $year: { date: '$createdAt', timezone } }, month: { $month: { date: '$createdAt', timezone } } } }, { $match: { year } }, { $group: { _id: '$month', tickets: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months.map((month, index) => ({ month, tickets: rows.find(row => row._id === index + 1)?.tickets || 0 }));
}
app.get('/api/dashboard/ticket-volume', auth, async (req, res) => res.json(await ticketVolumeByMonth(corporateCompany(req))));
app.get('/api/dashboard/location-distribution', auth, allowRoles('corporate_admin'), async (req, res) => res.json(await Device.aggregate([{ $match: corporateCompany(req) }, { $group: { _id: '$location', value: { $sum: 1 } } }, { $project: { _id: 0, name: '$_id', value: 1 } }])));
app.get('/api/profile', auth, allowRoles('corporate_admin'), async (req, res) => { const user = await User.findById(req.user.id).populate('companyId').select('-password'); if (!user) return res.status(404).json({ message: 'Profile not found' }); const numberOfDevices = await Device.countDocuments(corporateCompany(req)); res.json({ ...user.toObject(), primaryLocation: user.companyId?.location || 'Chennai', numberOfDevices }); });
app.get('/api/corporate/notifications', auth, allowRoles('corporate_admin'), async (req, res) => res.json(await Notification.find({ user: req.user.id, company: req.user.companyId }).populate('ticket', 'ticketId status issueType').populate('device', 'model serialNumber').sort({ createdAt: -1 }).limit(NOTIFICATION_LIST_LIMIT).lean()));
app.get('/api/corporate/notifications/unread-count', auth, allowRoles('corporate_admin'), async (req, res) => res.json({ count: await Notification.countDocuments({ user: req.user.id, company: req.user.companyId, read: false }) }));
app.patch('/api/corporate/notifications/:id/read', auth, allowRoles('corporate_admin'), async (req, res) => { const notification = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user.id, company: req.user.companyId }, { read: true }, { new: true }); if (!notification) return res.status(404).json({ message: 'Notification not found' }); res.json(notification); });
app.patch('/api/corporate/notifications/read-all', auth, allowRoles('corporate_admin'), async (req, res) => { await Notification.updateMany({ user: req.user.id, company: req.user.companyId, read: false }, { read: true }); res.json({ ok: true }); });
app.patch('/api/corporate/devices/:id/assign', auth, allowRoles('corporate_admin'), async (req, res) => { const device = await Device.findOne({ _id: req.params.id, companyId: req.user.companyId }); if (!device) return res.status(404).json({ message: 'Device not found in your company inventory' }); // The employee is optional: without one the device is still marked Assigned and keeps its location.
  const employeeName = String(req.body.employeeName || '').trim(); const employeeId = String(req.body.employeeId || '').trim(); if (Boolean(employeeName) !== Boolean(employeeId)) return res.status(400).json({ message: 'Provide both the employee name and ID, or neither.' }); device.employeeName = employeeName || undefined; device.employeeId = employeeId || undefined; device.department = employeeName ? req.body.department : undefined; if (employeeName && req.body.location) device.location = req.body.location; device.deviceAllocationStatus = 'Assigned'; await device.save(); await Notification.updateMany({ user: req.user.id, company: req.user.companyId, device: device._id, type: 'NEW_DEVICE' }, { read: true }); res.json(device); });

// A service-centre user sees reviews for its centre: monthly reviews list every centre involved.
function reviewTicketQueryForService(req) { return req.user.serviceCentreId ? { $or: [{ serviceCentreId: req.user.serviceCentreId }, { serviceCentreIds: req.user.serviceCentreId }] } : {}; }
const reviewModels = { Company, User, Notification, Review, Ticket, TicketTimeline };
const reviewPopulate = query => query.populate('ticketId').populate('ticketIds', 'ticketId issueType category').populate('customerId', 'name').populate('corporateId').populate('serviceCentreId').populate('serviceCentreIds', 'name').populate('deviceId');
app.post('/api/reviews', auth, allowRoles('corporate_admin'), async (req, res) => {
  const { period, rating, comment } = req.body || {};
  const cleanComment = String(comment || '').trim();
  if (!isPeriod(period)) return res.status(400).json({ message: 'Choose the month you are reviewing.' });
  if (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5) return res.status(400).json({ message: 'Rating must be an integer from 1 to 5.' });
  if (!cleanComment) return res.status(400).json({ message: 'A review comment is required.' });
  if (cleanComment.length > 2000) return res.status(400).json({ message: 'Review comment must be 2000 characters or fewer.' });
  const summary = await reviewPeriod(reviewModels, req.user.companyId, period);
  if (!summary) return res.status(404).json({ message: 'No service requests were closed in that month.' });
  if (summary.review) return res.status(409).json({ message: `${summary.label} has already been reviewed.` });
  if (!summary.ended) return res.status(400).json({ message: `${summary.label} can be reviewed once the month has ended.` });
  const tickets = await Ticket.find({ _id: { $in: summary.tickets.map(ticket => ticket._id) } }).select('serviceCentreId');
  const serviceCentreIds = [...new Set(tickets.map(ticket => ticket.serviceCentreId && String(ticket.serviceCentreId)).filter(Boolean))];
  try {
    const review = await Review.create({ period, ticketIds: summary.tickets.map(ticket => ticket._id), serviceCentreIds, corporateId: req.user.companyId, customerId: req.user.id, rating: Number(rating), comment: cleanComment });
    const recipients = serviceCentreIds.length ? (await Promise.all(serviceCentreIds.map(serviceUsersForCentre))).flat() : await serviceUsers();
    const unique = [...new Map(recipients.map(user => [String(user._id), user])).values()];
    await notifyUsers({ users: unique, company: req.user.companyId, reviewId: review._id, type: 'NEW_CUSTOMER_REVIEW', title: 'New Customer Review', message: `A corporate customer rated their ${summary.label} service (${summary.ticketCount} closed request${summary.ticketCount === 1 ? '' : 's'}).`, action: { type: 'NEW_CUSTOMER_REVIEW', reviewId: String(review._id), route: `/service/reviews/${review._id}` } });
    await Notification.updateMany({ company: req.user.companyId, type: 'RATE_SERVICE', 'action.period': period }, { read: true });
    res.status(201).json(review);
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: `${summary.label} has already been reviewed.` });
    throw error;
  }
});
// Months with closed requests, newest first; each says whether it can be reviewed yet.
app.get('/api/reviews/periods', auth, allowRoles('corporate_admin'), async (req, res) => res.json(await reviewPeriods(reviewModels, req.user.companyId)));
// Accepts a month, or a ticket ID from an older per-request review link.
app.get('/api/reviews/periods/:key', auth, allowRoles('corporate_admin'), async (req, res) => {
  let period = req.params.key;
  if (!isPeriod(period)) {
    const ticket = mongoose.isObjectIdOrHexString(period) ? await Ticket.findOne({ _id: period, companyId: req.user.companyId }) : null;
    period = ticket ? await ticketReviewPeriod(reviewModels, ticket) : null;
  }
  const summary = period ? await reviewPeriod(reviewModels, req.user.companyId, period) : null;
  if (!summary) return res.status(404).json({ message: 'No closed service requests to review for that month.' });
  res.json(summary);
});
app.get('/api/reviews/my', auth, allowRoles('corporate_admin'), async (req, res) => res.json(await reviewPopulate(Review.find({ corporateId: req.user.companyId })).sort({ createdAt: -1 })));
app.get('/api/reviews/:id', auth, allowRoles('corporate_admin'), async (req, res) => { const review = await reviewPopulate(Review.findOne({ _id: req.params.id, corporateId: req.user.companyId })); if (!review) return res.status(404).json({ message: 'Review not found.' }); res.json(review); });
app.get('/api/service/reviews', ...serviceAuth, async (req, res) => {
  const conditions = [reviewTicketQueryForService(req)];
  if (req.query.rating) conditions.push({ rating: Number(req.query.rating) });
  if (req.query.serviceCentreId && !req.user.serviceCentreId) conditions.push({ $or: [{ serviceCentreId: req.query.serviceCentreId }, { serviceCentreIds: req.query.serviceCentreId }] });
  if (req.query.search) {
    const search = escapeRegex(String(req.query.search).trim());
    const ids = (await Ticket.find({ ticketId: { $regex: search, $options: 'i' } }).select('_id')).map(ticket => ticket._id);
    conditions.push({ $or: [{ ticketId: { $in: ids } }, { ticketIds: { $in: ids } }, { period: { $regex: `^${search}` } }] });
  }
  res.json(await reviewPopulate(Review.find({ $and: conditions })).sort({ createdAt: -1 }));
});
app.get('/api/service/reviews/:id', ...serviceAuth, async (req, res) => { const review = await reviewPopulate(Review.findOne({ $and: [{ _id: req.params.id }, reviewTicketQueryForService(req)] })); if (!review) return res.status(404).json({ message: 'Review not found.' }); res.json(review); });

async function serviceTicket(id) { return Ticket.findById(id).populate('customerId').populate('companyId').populate('serviceCentreId').populate('deviceId').populate('assignedEngineerId'); }
async function addTimeline(ticket, status, message, user) { ticket.status = status; ticket.updatedAt = new Date(); if (status === 'Closed') ticket.closedAt = ticket.updatedAt; await ticket.save(); const entry = await TicketTimeline.create({ ticketId: ticket._id, status, message, updatedBy: user.name, userRole: user.role, timestamp: new Date() }); await ticketEmails.queueUpdate({ ticket, entry, device: ticket.deviceId }); return entry; }
async function notifyTicketUpdate(ticket, device, type, title, message) {
  const [service, admins] = await Promise.all([serviceUsers(), User.find({ role: 'corporate_admin', companyId: ticket.companyId })]);
  await Promise.all([
    notifyUsers({ users: service, company: ticket.companyId, ticket, device, type, title, message }),
    notifyUsers({ users: admins, company: ticket.companyId, ticket, device, type, title, message })
  ]);
}
app.get('/api/iplanet/tickets', ...serviceAuth, async (req, res) => {
  const query = {};
  for (const field of ['status', 'priority', 'location', 'companyId', 'slaStatus', 'escalationStatus']) if (req.query[field] && req.query[field] !== 'All') query[field] = req.query[field];
  if (req.query.assignment === 'Unassigned') query.assignedEngineerId = null;
  if (req.query.assignment === 'Assigned') query.assignedEngineerId = { $ne: null };
  // A YYYY-MM-DD filter means that calendar day in India, not UTC midnight to midnight.
  if (req.query.date) { const start = new Date(/^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? `${req.query.date}T00:00:00+05:30` : req.query.date); if (!Number.isNaN(start.getTime())) query.createdAt = { $gte: start, $lt: new Date(start.getTime() + 86400000) }; }
  const tickets = await Ticket.find(query).populate('customerId').populate('companyId').populate('deviceId').populate('assignedEngineerId').sort({ createdAt: -1 });
  const search = req.query.search?.toLowerCase();
  await Promise.all(tickets.map(ticket => evaluateEscalation(ticket, true)));
  res.json(search ? tickets.filter(ticket => JSON.stringify(ticket).toLowerCase().includes(search)) : tickets);
});
app.get('/api/iplanet/tickets/:id', ...serviceAuth, async (req, res) => { const ticket = await serviceTicket(req.params.id); if (!ticket) return res.status(404).json({ message: 'Service ticket not found' }); await evaluateEscalation(ticket, true); const [timeline, callHistory, aiSupport] = await Promise.all([TicketTimeline.find({ ticketId: ticket._id }).sort({ timestamp: 1 }), CallRecord.find({ ticketId: ticket._id }).sort({ createdAt: -1 }), AITroubleshootingSession.find({ ticketId: ticket._id }).sort({ createdAt: -1 })]); res.json({ ticket, coverage: { warrantyStatus: ticket.deviceId?.warrantyStatus, warrantyExpiry: ticket.deviceId?.warrantyExpiry, amcStatus: ticket.deviceId?.amcStatus, amcExpiry: ticket.deviceId?.amcExpiry, status: ticket.deviceId?.warrantyStatus === 'Active' || ticket.deviceId?.amcStatus === 'Active' ? 'Covered' : 'Not Covered', entitlements: ticket.deviceId?.warrantyStatus === 'Active' || ticket.deviceId?.amcStatus === 'Active' ? ['Repair', 'Parts Replacement', 'Remote Support'] : [] }, escalationContact: escalationContacts[ticket.escalationLevel] || null, timeline, callHistory, aiSupport }); });
app.get('/api/iplanet/companies', ...serviceAuth, async (_, res) => res.json(await Company.find().sort({ name: 1 })));
app.post('/api/iplanet/companies', ...serviceAuth, async (req, res) => { const { name, location, contactName, contactEmail, phone } = req.body; if (!name?.trim() || !location?.trim()) return res.status(400).json({ message: 'Corporate name and location are required' }); try { const company = await Company.create({ name: name.trim(), location: location.trim(), contactName, contactEmail, phone, companyId: `CO-${Date.now()}` }); res.status(201).json(company); } catch (error) { if (error.code === 11000) return res.status(409).json({ message: 'A Corporate with that name already exists' }); throw error; } });
app.get('/api/iplanet/service-centres', ...serviceAuth, async (_, res) => res.json(await ServiceCentre.find({ status: 'Active' }).sort({ name: 1 })));
app.post('/api/iplanet/service-centres', ...serviceAuth, async (req, res) => { const { name, location, address, city, state, contactNumber, email, status, serviceCentreId } = req.body; if (!name?.trim() || !location?.trim()) return res.status(400).json({ message: 'Service Centre name and location are required' }); try { res.status(201).json(await ServiceCentre.create({ serviceCentreId: serviceCentreId || undefined, name: name.trim(), location: location.trim(), address, city, state, contactNumber, email, status: status || 'Active' })); } catch (error) { if (error.code === 11000) return res.status(409).json({ message: 'A Service Centre with that name already exists' }); throw error; } });
app.get('/api/iplanet/engineers', ...serviceAuth, async (_, res) => { const engineers = await Engineer.find().populate('userId', 'name email role phone'); const tickets = await Ticket.find({ assignedEngineerId: { $ne: null }, status: { $nin: ['Completed', 'Closed'] } }).select('assignedEngineerId').lean(); res.json(engineers.map(engineer => ({ ...engineer.toObject(), assignedTicketCount: tickets.filter(ticket => String(ticket.assignedEngineerId) === String(engineer._id)).length }))); });
app.post('/api/iplanet/tickets/:id/assign', ...serviceAuth, async (req, res) => { const ticket = await serviceTicket(req.params.id); const engineer = await Engineer.findById(req.body.engineerId); if (!ticket || !engineer) return res.status(404).json({ message: 'Ticket or engineer not found' }); if (!['Open', 'Engineer Assigned'].includes(ticket.status)) return res.status(409).json({ message: `Cannot assign an engineer to a ${ticket.status} ticket` }); ticket.assignedEngineer = engineer.name; ticket.assignedEngineerId = engineer._id; ticket.assignedAt = new Date(); await addTimeline(ticket, 'Engineer Assigned', `${engineer.name} assigned to the service request.`, req.user); await notifyTicketUpdate(ticket, ticket.deviceId, 'ENGINEER_ASSIGNED', 'Engineer assigned', `Engineer ${engineer.name} was assigned to ${ticket.ticketId}.`); res.json(await serviceTicket(ticket._id)); });
app.get('/api/iplanet/tickets/:id/calls', ...serviceAuth, async (req, res) => { const ticket = await serviceTicket(req.params.id); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); res.json(await CallRecord.find({ ticketId: ticket._id }).sort({ createdAt: -1 })); });
app.post('/api/iplanet/tickets/:id/calls', ...serviceAuth, async (req, res) => { const ticket = await serviceTicket(req.params.id); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); const customerPhone = req.body.customerPhone || ticket.customerId?.phone || ticket.companyId?.phone || ''; const record = await CallRecord.create({ ticketId: ticket._id, agentUserId: req.user.id, agentName: req.user.name || 'Service Agent', ticketNumber: ticket.ticketId, customerName: ticket.customerId?.name || ticket.companyId?.name || 'Customer', customerPhone, outcome: req.body.outcome || 'Customer Unavailable', notes: req.body.notes || '', callStatus: req.body.callStatus || 'Call Attempted' }); await TicketTimeline.create({ ticketId: ticket._id, status: 'Call Update', message: `${record.outcome}${record.notes ? `: ${record.notes}` : ''}`, updatedBy: record.agentName, userRole: req.user.role, timestamp: new Date() }); res.status(201).json(record); });
app.get('/api/iplanet/tickets/:id/ai-support', ...serviceAuth, async (req, res) => { const ticket = await serviceTicket(req.params.id); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); const session = await AITroubleshootingSession.findOne({ ticketId: ticket._id }).sort({ createdAt: -1 }); res.json({ session, sessionId: session?._id || null, hasAttempted: !!session }); });
app.post('/api/iplanet/tickets/:id/ai-support', ...serviceAuth, async (req, res) => { const ticket = await serviceTicket(req.params.id); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); const session = await buildAiSession(ticket, await AITroubleshootingSession.findOne({ ticketId: ticket._id }).sort({ createdAt: -1 })); const previousSteps = session.troubleshootingSteps.map(step => step.step);
  if (req.body.customerResponse) session.customerResponses.push({ response: req.body.customerResponse, timestamp: new Date() });
  if (req.body.stepResult) session.troubleshootingSteps.push({ step: req.body.stepLabel || 'Troubleshooting step', outcome: req.body.stepResult, timestamp: new Date() });
  try {
    const result = await callAiProvider({ deviceType: ticket.deviceId?.deviceType || 'Apple device', deviceModel: ticket.deviceId?.model || 'Unknown model', issueCategory: ticket.issueType || 'General support', issueDescription: ticket.description || '', ticketId: ticket.ticketId }, previousSteps, req.body.customerResponse || '');
    session.providerAvailable = result.available;
    session.providerStatus = result.available ? 'Available' : 'Unavailable';
    session.result = req.body.resolved ? 'Resolved' : (req.body.customerResponse ? 'Awaiting customer confirmation' : session.result);
    session.escalationStatus = req.body.resolved ? 'Resolved' : (req.body.unresolved ? 'Recommended Service Assistance' : session.escalationStatus);
    if (result.available) session.troubleshootingSteps.push({ step: result.message, outcome: req.body.customerResponse ? 'Awaiting customer confirmation' : 'Next step suggested', timestamp: new Date() });
    await session.save();
    res.json({ session, available: result.available, message: result.message });
  } catch (error) {
    session.providerAvailable = false;
    session.providerStatus = 'Unavailable';
    session.result = 'AI unavailable';
    await session.save();
    res.status(503).json({ message: 'AI troubleshooting is currently unavailable.', session });
  }
});
async function engineerAction(req, res, status, message, title = `${status} update`) { const ticket = await serviceTicket(req.params.id); if (!ticket) return res.status(404).json({ message: 'Service ticket not found' }); if (!ticket.assignedEngineerId) return res.status(409).json({ message: 'Assign an engineer before updating this ticket' }); if (!transitions[ticket.status]?.includes(status)) return res.status(409).json({ message: `Cannot move a ${ticket.status} ticket to ${status}` }); const updateMessage = req.body.note?.trim() || message || `${status} update recorded.`; await addTimeline(ticket, status, updateMessage, req.user); await notifyTicketUpdate(ticket, ticket.deviceId, 'TICKET_UPDATE', title, `${ticket.ticketId}: ${updateMessage}`); if (status === 'Completed') await proactiveEngine.onTicketCompleted(ticket); await evaluateEscalation(ticket, true); res.json(await serviceTicket(ticket._id)); }
app.post('/api/iplanet/tickets/:id/accept', ...serviceAuth, async (req, res) => engineerAction(req, res, 'Engineer Accepted', 'Engineer accepted the service assignment.'));
app.post('/api/iplanet/tickets/:id/start', ...serviceAuth, async (req, res) => engineerAction(req, res, 'In Progress', 'Work started on the service request.', 'Work started'));
app.post('/api/iplanet/tickets/:id/waiting-parts', ...serviceAuth, async (req, res) => engineerAction(req, res, 'Waiting for Parts', 'Waiting for replacement parts.', 'Waiting for parts'));
app.post('/api/iplanet/tickets/:id/complete', ...serviceAuth, async (req, res) => engineerAction(req, res, 'Completed', 'Repair completed and tested successfully.', 'Repair completed'));
app.post('/api/iplanet/tickets/:id/close', ...serviceAuth, async (req, res) => engineerAction(req, res, 'Closed', 'Ticket closed after service completion.', 'Ticket closed'));
app.post('/api/iplanet/tickets/:id/update', ...serviceAuth, async (req, res) => engineerAction(req, res, req.body.status, req.body.note || 'Service update recorded.'));
app.get('/api/iplanet/dashboard', ...serviceAuth, async (_, res) => { const tickets = await Ticket.find(); await Promise.all(tickets.map(ticket => evaluateEscalation(ticket, true))); const count = status => tickets.filter(ticket => ticket.status === status).length; res.json({ stats: { newRequests: count('Open'), unassigned: tickets.filter(ticket => !ticket.assignedEngineerId).length, assigned: count('Engineer Assigned') + count('Engineer Accepted'), inProgress: count('In Progress'), waitingParts: count('Waiting for Parts'), completed: count('Completed'), closed: count('Closed'), activeEscalations: tickets.filter(ticket => ticket.escalationStatus === 'Escalated').length, atRisk: tickets.filter(ticket => ticket.escalationStatus === 'At Risk').length, breached: tickets.filter(ticket => ticket.escalationStatus === 'SLA Breached').length }, volume: await ticketVolumeByMonth(), locations: await Ticket.aggregate([{ $group: { _id: '$location', value: { $sum: 1 } } }, { $project: { _id: 0, name: '$_id', value: 1 } }]) }); });
// Latest ticket timeline events across all tickets, plus how many tickets were
// completed since `since` (the client's local midnight, so "today" matches the
// viewer's day rather than the server's time zone).
app.get('/api/iplanet/activity', ...serviceAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 8, 1), 50);
  const requested = req.query.since ? new Date(req.query.since) : null;
  const since = requested && !Number.isNaN(requested.getTime()) ? requested : new Date(new Date().setHours(0, 0, 0, 0));
  const [events, completedTicketIds] = await Promise.all([
    TicketTimeline.find().sort({ timestamp: -1 }).limit(limit).populate({ path: 'ticketId', select: 'ticketId issueType status location companyId deviceId', populate: [{ path: 'companyId', select: 'name' }, { path: 'deviceId', select: 'model serialNumber' }] }),
    TicketTimeline.distinct('ticketId', { status: 'Completed', timestamp: { $gte: since } }),
  ]);
  res.json({ events: events.filter(event => event.ticketId), completedToday: completedTicketIds.length, since });
});
// ---------------------------------------------------------------------------
// Proactive device service. The engine owns every calculation; these routes
// only authorise the caller and scope what they can see. Corporate users are
// always scoped to their own company from the token, never from the request.
// ---------------------------------------------------------------------------
const proactiveEngine = createProactiveEngine({ notifyUsers });
const proactiveScheduler = createProactiveScheduler({ engine: proactiveEngine, minutes: proactiveConfig.schedulerMinutes });
const proactiveRoute = handler => async (req, res) => {
  try { await handler(req, res); } catch (error) {
    if (error instanceof ProactiveServiceError) return res.status(error.status).json({ message: error.message });
    console.error('[Proactive service]', error);
    res.status(500).json({ message: 'Proactive service is temporarily unavailable.' });
  }
};
const serviceScope = req => (req.user.serviceCentreId ? { serviceCentreId: req.user.serviceCentreId } : {});
const PROACTIVE_FILTERS = ['status', 'companyId', 'serviceCentreId', 'location', 'dueWithin', 'deviceType', 'warranty', 'amc', 'search', 'view'];
const proactiveFilters = query => Object.fromEntries(PROACTIVE_FILTERS.filter(key => typeof query[key] === 'string' && query[key]).map(key => [key, query[key].slice(0, 120)]));
const SERVICE_FOLLOW_UP_ACTIONS = ['contact', 'schedule', 'remind-later', 'mark-not-required'];
const CORPORATE_RECOMMENDATION_ACTIONS = ['schedule-later', 'not-required'];

app.get('/api/iplanet/proactive-service/followups', ...serviceAuth, proactiveRoute(async (req, res) => res.json(await proactiveEngine.list({ scope: serviceScope(req), filters: proactiveFilters(req.query) }))));
app.get('/api/iplanet/proactive-service/followups/:id', ...serviceAuth, proactiveRoute(async (req, res) => res.json(await proactiveEngine.detail(req.params.id, serviceScope(req)))));
app.post('/api/iplanet/proactive-service/followups/:id/:action', ...serviceAuth, proactiveRoute(async (req, res) => {
  if (!SERVICE_FOLLOW_UP_ACTIONS.includes(req.params.action)) return res.status(404).json({ message: 'Unknown action' });
  res.json(await proactiveEngine.serviceAction(req.params.id, req.params.action, req.body, req.user, serviceScope(req)));
}));
app.patch('/api/iplanet/devices/:id/service-plan', ...serviceAuth, proactiveRoute(async (req, res) => res.json(await proactiveEngine.updatePlan(req.params.id, req.body, serviceScope(req)))));
app.get('/api/iplanet/proactive-service/scheduler', ...serviceAuth, (_, res) => res.json(proactiveScheduler.status()));
app.post('/api/iplanet/proactive-service/run', ...serviceAuth, proactiveRoute(async (_, res) => res.json(await proactiveScheduler.run('manual'))));
// External cron trigger. Disabled unless PROACTIVE_SERVICE_CRON_SECRET is set.
app.post('/api/internal/proactive-service/run', proactiveRoute(async (req, res) => {
  if (!proactiveConfig.cronSecret) return res.status(404).json({ message: 'Not found' });
  if (req.get('authorization') !== `Bearer ${proactiveConfig.cronSecret}`) return res.status(401).json({ message: 'Unauthorized' });
  res.json(await proactiveScheduler.run('cron'));
}));

app.get('/api/corporate/service-recommendations', auth, allowRoles('corporate_admin'), proactiveRoute(async (req, res) => {
  const filters = proactiveFilters(req.query);
  delete filters.companyId;
  delete filters.serviceCentreId;
  res.json(await proactiveEngine.list({ scope: { companyId: req.user.companyId }, filters }));
}));
app.get('/api/corporate/service-recommendations/:id', auth, allowRoles('corporate_admin'), proactiveRoute(async (req, res) => {
  const { contact, contactLog, options, ...item } = await proactiveEngine.detail(req.params.id, { companyId: req.user.companyId });
  res.json({ ...item, options: { notRequiredReasons: options.notRequiredReasons }, lastContact: item.lastContact ? { at: item.lastContact.at, method: item.lastContact.method, outcome: item.lastContact.outcome } : null });
}));
app.post('/api/corporate/service-recommendations/:id/:action', auth, allowRoles('corporate_admin'), proactiveRoute(async (req, res) => {
  if (!CORPORATE_RECOMMENDATION_ACTIONS.includes(req.params.action)) return res.status(404).json({ message: 'Unknown action' });
  const { contact, contactLog, ...item } = await proactiveEngine.corporateAction(req.params.id, req.params.action, req.body, req.user);
  res.json(item);
}));
app.get('/api/corporate/devices/:id/service-plan', auth, allowRoles('corporate_admin'), proactiveRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Device not found' });
  res.json(await proactiveEngine.devicePlan(req.params.id, { companyId: req.user.companyId }));
}));
app.get('/api/iplanet/reports', ...serviceAuth, async (_, res) => { const tickets = await Ticket.find().populate('deviceId'); const group = key => Object.entries(tickets.reduce((result, ticket) => { const value = key === 'deviceType' ? ticket.deviceId?.deviceType : ticket[key]; result[value || 'Other'] = (result[value || 'Other'] || 0) + 1; return result; }, {})).map(([name, value]) => ({ name, value })); res.json({ total: tickets.length, open: tickets.filter(t => t.status === 'Open').length, completed: tickets.filter(t => t.status === 'Completed').length, closed: tickets.filter(t => t.status === 'Closed').length, averageClosureTat: '2.4 days', locations: group('location'), deviceTypes: group('deviceType'), issueTypes: group('issueType') }); });
app.get('/api/iplanet/notifications', ...serviceAuth, async (req, res) => {
  const query = { user: req.user.id, portalRole: 'iplanet_service' };
  if (req.user.serviceCentreId) query.serviceCentreId = { $in: [req.user.serviceCentreId, null] };
  res.json(await Notification.find(query).populate('ticket', 'ticketId status issueType').populate('device', 'model serialNumber').sort({ createdAt: -1 }).limit(NOTIFICATION_LIST_LIMIT).lean());
});
app.get('/api/iplanet/notifications/unread-count', ...serviceAuth, async (req, res) => {
  const query = { user: req.user.id, portalRole: 'iplanet_service', read: false };
  if (req.user.serviceCentreId) query.serviceCentreId = { $in: [req.user.serviceCentreId, null] };
  res.json({ count: await Notification.countDocuments(query) });
});
app.patch('/api/iplanet/notifications/:id/read', ...serviceAuth, async (req, res) => {
  const query = { _id: req.params.id, user: req.user.id, portalRole: 'iplanet_service' };
  if (req.user.serviceCentreId) query.serviceCentreId = { $in: [req.user.serviceCentreId, null] };
  const notification = await Notification.findOneAndUpdate(query, { read: true }, { new: true });
  if (!notification) return res.status(404).json({ message: 'Notification not found' });
  res.json(notification);
});
app.patch('/api/iplanet/notifications/read-all', ...serviceAuth, async (req, res) => {
  const query = { user: req.user.id, portalRole: 'iplanet_service', read: false };
  if (req.user.serviceCentreId) query.serviceCentreId = { $in: [req.user.serviceCentreId, null] };
  await Notification.updateMany(query, { read: true });
  res.json({ ok: true });
});
app.get('/api/escalation-matrix', auth, async (_, res) => res.json(Object.values(escalationContacts).map(contact => ({ ...contact, trigger: contact.level === 1 ? 'SLA approaching' : contact.level === 2 ? 'SLA breached' : 'Critical SLA breach' }))));
app.get('/api/iplanet/escalation-rules', ...serviceAuth, async (_, res) => res.json(await EscalationRule.find().sort({ level: 1, slaThreshold: 1 })));
app.post('/api/iplanet/escalation-rules', ...serviceAuth, async (req, res) => { const { name, level, trigger, priority, slaThreshold, action, isActive } = req.body; if (!name?.trim() || !level || !trigger || !action?.trim() || !Number.isFinite(Number(slaThreshold)) || Number(slaThreshold) < 0 || Number(slaThreshold) > 100) return res.status(400).json({ message: 'Rule name, level, trigger, valid SLA threshold, and action are required' }); const rule = await EscalationRule.create({ name: name.trim(), level: Number(level), trigger, priority: priority || 'All', slaThreshold: Number(slaThreshold), action: action.trim(), isActive: isActive !== false }); clearEscalationRuleCache(); res.status(201).json(rule); });
app.patch('/api/iplanet/escalation-rules/:id', ...serviceAuth, async (req, res) => { const rule = await EscalationRule.findByIdAndUpdate(req.params.id, { ...req.body, ...(req.body.slaThreshold !== undefined ? { slaThreshold: Number(req.body.slaThreshold) } : {}) }, { new: true, runValidators: true }); if (!rule) return res.status(404).json({ message: 'Escalation rule not found' }); clearEscalationRuleCache(); res.json(rule); });
// A warranty or AMC that is still valid but expiring soon still covers the device.
const isCovered = device => ['Active', 'Expiring Soon'].includes(device.warrantyStatus) || ['Active', 'Expiring Soon'].includes(device.amcStatus);
// `sources` uses the same filter as the device list, so its total matches summary.total.
app.get('/api/coverage', auth, async (req, res) => { const query = corporateCompany(req); const [devices, sources] = await Promise.all([Device.find(query).populate('companyId').sort({ model: 1 }), deviceSourceCounts(Device, query)]); const covered = devices.map(device => ({ ...device.toObject(), coverageStatus: isCovered(device) ? 'Covered' : 'Not Covered', entitlements: isCovered(device) ? ['Repair', 'Parts Replacement', 'Remote Support'] : [] })); res.json({ summary: { total: covered.length, warrantyActive: covered.filter(device => device.warrantyStatus === 'Active').length, amcActive: covered.filter(device => device.amcStatus === 'Active').length, expiringSoon: covered.filter(device => device.warrantyStatus === 'Expiring Soon' || device.amcStatus === 'Expiring Soon').length, expired: covered.filter(device => device.warrantyStatus === 'Expired' || device.amcStatus === 'Expired').length, sources }, devices: covered }); });
app.get('/api/tickets/:id/escalation', auth, async (req, res) => { if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Ticket not found' }); const ticket = await Ticket.findOne({ _id: req.params.id, ...(req.user.role === 'corporate_admin' ? { companyId: req.user.companyId } : {}) }); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); await evaluateEscalation(ticket, true); res.json({ escalation: { status: ticket.escalationStatus, level: ticket.escalationLevel, reason: ticket.escalationReason, escalatedAt: ticket.escalatedAt, slaStatus: ticket.slaStatus, responseTarget: ticket.responseTarget, resolutionTarget: ticket.resolutionTarget, slaTargetAt: ticket.slaTargetAt }, escalationContact: escalationContacts[ticket.escalationLevel] || null, history: await TicketTimeline.find({ ticketId: ticket._id, status: { $in: ['At Risk', 'SLA Breached', 'Escalated'] } }).sort({ timestamp: 1 }) }); });
app.get('/api/iplanet/device-master', ...serviceAuth, async (_, res) => res.json(await DeviceMaster.find().sort({ serialNumber: 1 })));
app.get('/api/iplanet/device-master/:serialNumber', ...serviceAuth, async (req, res) => { const device = await DeviceMaster.findOne({ serialNumber: req.params.serialNumber }); if (!device) return res.status(404).json({ message: 'Device not found. Please verify the serial number.' }); res.json(device); });
app.post('/api/iplanet/devices/enroll', ...serviceAuth, async (req, res) => { const master = await DeviceMaster.findOne({ serialNumber: req.body.serialNumber }); const selectedEntityType = req.body.selectedEntityType; const selectedEntityId = req.body.selectedEntityId; const company = selectedEntityType === 'corporate' ? await Company.findById(selectedEntityId) : null; const centre = selectedEntityType === 'service_centre' ? await ServiceCentre.findById(selectedEntityId) : null; if (!master) return res.status(404).json({ message: 'Device not found. Please verify the serial number.' }); if (!['corporate', 'service_centre'].includes(selectedEntityType) || !selectedEntityId || (!company && !centre)) return res.status(400).json({ message: 'Select a valid Corporate or Service Centre' }); let device = await Device.findOne({ serialNumber: master.serialNumber }); const values = { selectedEntityId, selectedEntityType, ...(company ? { companyId: company._id, location: company.location } : { companyId: null, location: centre.location }), employeeName: null, employeeId: null, department: null, deviceAllocationStatus: 'Unassigned' }; if (device) { Object.assign(device, values); await device.save(); } else { device = await Device.create({ serialNumber: master.serialNumber, deviceType: master.deviceType, model: master.model, assetId: master.assetId, purchaseDate: master.purchaseDate, warrantyStatus: master.warrantyStatus, warrantyExpiry: master.warrantyExpiry, amcStatus: master.amcStatus, amcExpiry: master.amcExpiry, ...values, deviceStatus: 'In Use', deviceSource: DEVICE_SOURCES.IPLANET }); } const admins = company ? await User.find({ role: 'corporate_admin', companyId: company._id }) : []; await Notification.insertMany(admins.map(admin => ({ user: admin._id, company: company._id, type: 'NEW_DEVICE', title: 'New Device Added', message: `A new ${device.model} has been added to your organization.`, device: device._id, read: false }))); res.status(201).json(await device.populate('companyId')); });
// This must remain after every API route, including the review routes above.
// Returning JSON keeps clients from mistaking an unmounted endpoint for a ticket error.
// Corporate sign-up creates pending requests that iPlanet Service users approve; iPlanet
// Service sign-up is immediate but limited to SERVICE_SIGNUP_EMAIL_DOMAINS.
app.use('/api', createAccountRequestRouter({
  models: { AccountRequest, User, Company },
  auth,
  allowRoles,
  serviceEmailDomains: parseEmailDomains(process.env.SERVICE_SIGNUP_EMAIL_DOMAINS),
  onRequested: async request => notifyUsers({ users: await serviceUsers(), type: 'ACCOUNT_REQUEST', title: 'New account request', message: `${request.name} (${request.organization}) requested Corporate Self-Care access.`, action: { type: 'ACCOUNT_REQUEST', route: '/service/settings#account-requests' } }),
}));

// B2B service requests received by email (B2B_EMAIL_*): Claude drafts each one and an iPlanet
// Service user approves it into a ticket. Separate from the B2C email escalations.
const emailInbox = emailInboxConfig();
// Tickets created from these emails are acknowledged to the sender when opened (with a
// tracking link) and when closed. Links use the first portal address in FRONTEND_URLS.
const portalUrl = (String(process.env.FRONTEND_URLS || '').split(',').map(value => value.trim()).find(Boolean) || 'http://localhost:5173').replace(/\/+$/, '');
const ticketEmails = createTicketEmailUpdates({ models: { TicketEmail }, send: createSmtpSender(emailInbox), fromAddress: emailInbox.user, trackingUrl: token => `${portalUrl}/track/${token}` });
async function createTicketFromEmail({ draft, emailRequest, reviewer }) {
  const onSite = isOnSiteRequest(draft.category);
  const images = emailRequest.attachments.filter(item => /^image\//.test(item.contentType)).map(item => item.path);
  const createdAt = new Date();
  const ticket = await createTicketWithUniqueId({ category: draft.category, issueType: onSite ? undefined : draft.issueType, description: draft.description, location: draft.location || undefined, preferredServiceDate: draft.preferredServiceDate || undefined, priority: draft.priority, ...(onSite ? { deviceCount: Number(draft.deviceCount) } : { deviceId: draft.deviceId }), customerId: draft.customerId, companyId: draft.companyId, status: 'Open', images, originalImages: images, annotatedImages: [], responseTarget: '4 business hours', resolutionTarget: `${targetHours(draft.priority)} hours`, slaTargetAt: new Date(createdAt.getTime() + targetHours(draft.priority) * 3600000), slaStatus: 'Healthy', escalationStatus: 'Not Escalated', emailSource: { address: emailRequest.from?.address, name: emailRequest.from?.name, messageId: emailRequest.messageId, subject: emailRequest.subject, trackingToken: crypto.randomBytes(24).toString('base64url') } });
  const entry = await TicketTimeline.create({ ticketId: ticket._id, status: 'Open', message: `Service request created from an email from ${emailRequest.from?.address || 'the customer'}, reviewed by ${reviewer.name || 'iPlanet Service'}.`, updatedBy: 'Email Requests', userRole: 'iplanet_service' });
  await ticketEmails.queueUpdate({ ticket, entry, device: draft.deviceId ? await Device.findById(draft.deviceId).lean() : null, created: true });
  const admins = await User.find({ role: 'corporate_admin', companyId: draft.companyId });
  await notifyUsers({ users: admins, company: draft.companyId, ticket, type: 'NEW_SERVICE_REQUEST', title: 'Emailed request logged', message: `Your email "${emailRequest.subject || 'service request'}" was logged as ${ticket.ticketId}.` });
  return ticket;
}
const emailRequests = createEmailRequestModule({
  models: { EmailRequest, User, Company, Device },
  auth,
  allowRoles,
  mailbox: createImapMailbox(emailInbox),
  extract: createClaudeEmailExtractor(),
  uploadDir,
  createTicket: createTicketFromEmail,
  onReceived: async request => notifyUsers({ users: await serviceUsers(), type: 'EMAIL_REQUEST', title: 'New email request', message: `${request.from?.name || request.from?.address}: ${request.subject || '(no subject)'}`, action: { type: 'EMAIL_REQUEST', route: `/service/email-requests?id=${request._id}` } }),
});
app.use('/api/iplanet/email-requests', emailRequests.router);

// Public tracking page for a ticket raised by email. The token in the emailed link is the
// only key, so the response holds just what the customer needs: the service statuses
// (no SLA alerts or call notes), and no internal IDs, reviewers or contact details.
const TRACKED_STATUSES = Object.keys(transitions);
app.get('/api/track/:token', async (req, res) => {
  const notFound = () => res.status(404).json({ message: 'This tracking link is not valid.' });
  if (!/^[A-Za-z0-9_-]{32}$/.test(req.params.token)) return notFound();
  const ticket = await Ticket.findOne({ 'emailSource.trackingToken': req.params.token }).populate('deviceId', 'model serialNumber').populate('companyId', 'name').lean();
  if (!ticket) return notFound();
  const timeline = await TicketTimeline.find({ ticketId: ticket._id, status: { $in: TRACKED_STATUSES } }).sort({ timestamp: 1 }).lean();
  res.json({
    ticketId: ticket.ticketId, status: ticket.status, category: ticket.category, issueType: ticket.issueType || null, priority: ticket.priority,
    company: ticket.companyId?.name || null, device: ticket.deviceId ? { model: ticket.deviceId.model, serialNumber: ticket.deviceId.serialNumber } : null,
    deviceCount: ticket.deviceCount || null, location: ticket.location || null, preferredServiceDate: ticket.preferredServiceDate || null,
    engineer: ticket.assignedEngineer || null, createdAt: ticket.createdAt, closedAt: ticket.closedAt || null,
    timeline: timeline.map(entry => ({ status: entry.status, message: entry.status === 'Open' ? 'Service request logged.' : entry.message, at: entry.timestamp })),
  });
});

app.use('/api', (req, res) => res.status(404).json({ message: `API endpoint not found: ${req.method} ${req.originalUrl}` }));
// Client mistakes get a specific 4xx; anything else is a server fault, logged here and
// answered with a generic message so database and stack details never reach the browser.
app.use((error, req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5 MB or smaller.' : error.code === 'LIMIT_UNEXPECTED_FILE' ? 'Attach up to 5 images.' : 'The upload could not be processed.' });
  if (error instanceof mongoose.Error.CastError) return res.status(404).json({ message: 'Record not found' });
  if (error instanceof mongoose.Error.ValidationError) return res.status(400).json({ message: Object.values(error.errors).map(item => item.message).join(' ') || 'Invalid data' });
  if (error?.code === 11000) return res.status(409).json({ message: 'A record with these details already exists' });
  if (/not allowed by CORS/.test(error?.message || '')) return res.status(403).json({ message: 'Origin not allowed' });
  const status = Number(error?.status || error?.statusCode);
  if (status >= 400 && status < 500) return res.status(status).json({ message: error.expose === false ? 'Invalid request' : error.message || 'Invalid request' });
  console.error(`[API ERROR] ${req.method} ${req.originalUrl}: ${error?.name || 'Error'} ${error?.message || ''}`);
  return res.status(500).json({ message: 'Something went wrong. Please try again.' });
});
const port = process.env.PORT || 5000;
async function ensureEscalationRules() { const defaults = [{ name: 'SLA Approaching', level: 1, trigger: 'SLA Approaching', priority: 'All', slaThreshold: 80, action: 'Notify Service Coordinator' }, { name: 'SLA Breach', level: 2, trigger: 'SLA Breached', priority: 'All', slaThreshold: 100, action: 'Escalate to Service Manager' }, { name: 'Critical SLA Breach', level: 3, trigger: 'Critical SLA Breach', priority: 'Critical', slaThreshold: 100, action: 'Escalate to Regional Operations Manager' }]; if (await EscalationRule.countDocuments() === 0) await EscalationRule.insertMany(defaults); }
async function ensureServiceCentres() { if (await ServiceCentre.countDocuments() === 0) await ServiceCentre.insertMany(['Chennai', 'Coimbatore', 'Bengaluru', 'Madurai'].map(location => ({ name: `${location} Service Centre`, location, status: 'Active' }))); }
// syncIndexes replaces the old one-review-per-ticket unique index with the monthly ones.
async function ensureReviewIndexes() { await Review.syncIndexes(); }
// The per-organization asset ID index. Existing duplicate asset IDs would stop it being built;
// registration still checks for duplicates itself, so that is logged rather than fatal.
async function ensureDeviceIndexes() { try { await Device.createIndexes(); } catch (error) { console.warn(`[Devices] Could not create device indexes: ${error.message}`); } }
async function ensureGoogleBusinessIntegrationIndexes() {
  const indexes = await GoogleBusinessIntegration.collection.indexes();
  for (const index of indexes) {
    if (index.name !== '_id_' && (Object.keys(index.key).includes('companyId') || Object.keys(index.key).includes('serviceCentreId'))) {
      await GoogleBusinessIntegration.collection.dropIndex(index.name);
    }
  }

  const incompleteIntegrations = await GoogleBusinessIntegration.find({ provider: null }).select('_id accessToken refreshToken').lean();
  let removed = 0;
  for (const integration of incompleteIntegrations) {
    if (!integration.accessToken && !integration.refreshToken) {
      await GoogleBusinessIntegration.deleteOne({ _id: integration._id });
      removed += 1;
    }
  }
  await GoogleBusinessIntegration.updateMany(
    { provider: null, $or: [{ accessToken: { $ne: null } }, { refreshToken: { $ne: null } }] },
    { $set: { provider: GOOGLE_BUSINESS_PROVIDER } }
  );

  const integrations = await GoogleBusinessIntegration.find({ provider: GOOGLE_BUSINESS_PROVIDER }).select('_id accessToken refreshToken').lean();
  if (integrations.length > 1) {
    const tokenless = integrations.filter(integration => !integration.accessToken && !integration.refreshToken);
    if (tokenless.length) {
      await GoogleBusinessIntegration.deleteMany({ _id: { $in: tokenless.map(integration => integration._id) } });
      removed += tokenless.length;
    }
  }
  const remainingIntegrations = await GoogleBusinessIntegration.countDocuments({ provider: GOOGLE_BUSINESS_PROVIDER });
  if (remainingIntegrations > 1) throw new Error('Google Business integration migration found multiple credential-bearing central integrations. Resolve duplicates before creating the provider index.');

  let migrated = 0;
  if (remainingIntegrations === 1) {
    await GoogleBusinessIntegration.collection.updateOne(
      { provider: GOOGLE_BUSINESS_PROVIDER },
      { $set: { provider: GOOGLE_BUSINESS_PROVIDER, portalRole: 'iplanet_service' }, $unset: { companyId: 1, serviceCentreId: 1 } }
    );
    migrated = 1;
  }
  if (migrated || removed) console.info(`[Google Business] Ownership migration: ${migrated} migrated, ${removed} invalid tokenless records removed.`);

  await GoogleBusinessIntegration.collection.createIndex(
    { provider: 1 },
    { unique: true, name: 'provider_1' }
  );
}
async function ensureGoogleBusinessLocationMappingIndexes() {
  const indexes = await GoogleBusinessLocationMapping.collection.indexes();
  for (const index of indexes) {
    if (index.name !== '_id_' && Object.keys(index.key).includes('companyId')) {
      await GoogleBusinessLocationMapping.collection.dropIndex(index.name);
    }
  }
  await GoogleBusinessLocationMapping.collection.createIndex(
    { serviceCentreId: 1, locationName: 1 },
    { unique: true, name: 'serviceCentre_locationName_unique' }
  );
}
async function ensureDemoEnrollmentDevices() {
  await Promise.all(demoEnrollmentDevices.map(device => DeviceMaster.updateOne({ serialNumber: device.serialNumber }, { $setOnInsert: device }, { upsert: true })));
}
async function ensureDemoAccounts() {
  let company = await Company.findOne({ name: 'Demo Corporation' });
  if (!company) company = await Company.create({ name: 'Demo Corporation', companyId: 'CO-003', contactName: 'Corporate Admin', contactEmail: 'admin@corporate.local', phone: '+91 90000 00000', location: 'Chennai' });
  await User.findOneAndUpdate(
    { email: 'admin@corporate.local' },
    { $setOnInsert: { name: 'Corporate Admin', email: 'admin@corporate.local', password: hashPassword('Demo@123'), role: 'corporate_admin', company: company.name, companyId: company._id, phone: company.phone } },
    { upsert: true, new: true }
  );
  await User.findOneAndUpdate(
    { email: 'service@iplanet.local' },
    { $setOnInsert: { name: 'iPlanet Service', email: 'service@iplanet.local', password: hashPassword('Demo@123'), role: 'iplanet_service', company: 'iPlanet Service Desk', phone: '+91 90000 00002' } },
    { upsert: true, new: true }
  );
}
 
mongoose.connect(process.env.MONGODB_URI).then(async () => { await ensureDemoAccounts(); await ensureDemoEnrollmentDevices(); await ensureEscalationRules(); await ensureServiceCentres(); await ensureReviewIndexes(); await ensureDeviceIndexes(); await ensureGoogleBusinessIntegrationIndexes(); await ensureGoogleBusinessLocationMappingIndexes(); await GoogleBusinessNotificationReceipt.createIndexes(); await ServiceFollowUp.createIndexes(); await AccountRequest.createIndexes(); await EmailRequest.createIndexes(); await TicketEmail.createIndexes(); await Ticket.createIndexes(); await b2c?.initialise({ hashPassword }); proactiveScheduler.start(); b2c?.scheduler.start(); startMonthlyReviewScheduler(reviewModels); emailRequests.scheduler.start(emailInbox.pollMinutes); ticketEmails.scheduler.start(emailInbox.pollMinutes); app.listen(port, '0.0.0.0', () => console.log(`API running at http://localhost:${port}`)); }).catch(error => { console.error('MongoDB connection failed:', error.message); process.exit(1); });
