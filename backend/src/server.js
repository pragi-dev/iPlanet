import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { User, Company, ServiceCentre, Device, DeviceMaster, Engineer, Ticket, TicketTimeline, Notification, EscalationRule, CallRecord, AITroubleshootingSession } from './models.js';
import { auth, allowRoles } from './middleware.js';
import { createAiSupportRouter } from './routes/aiSupport.js';
import { getAiSupportReply } from './ai/aiEngine.js';
import { buildSupportContext } from './ai/contextBuilder.js';
import { understandRequest, understandDeterministicResult, REQUEST_CATEGORIES, REQUEST_ISSUE_TYPES } from './ai/requestExtractor.js';
import { indiaToday, resolveServiceDateIntent } from './ai/serviceDate.js';
import { demoEnrollmentDevices } from './demoData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, '../../uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_, file, cb) => cb(null, /^image\//.test(file.mimetype)) });
const AI_SUPPORT_FALLBACK_MESSAGE = 'AI Support is temporarily unavailable. You can continue the request manually or contact the service team.';
const app = express();
const allowedOrigins = new Set((process.env.FRONTEND_URLS || 'http://localhost:5173,http://localhost:5174')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean));
const isAllowedOrigin = origin => {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    const hostname = new URL(origin).hostname;
    return ['localhost', '127.0.0.1'].includes(hostname)
      || hostname.endsWith('.loca.lt')
      || hostname.endsWith('.localtunnel.me')
      || hostname.endsWith('.devtunnels.ms')
      || hostname.endsWith('.app.github.dev')
      || hostname.endsWith('.vercel.app');
  } catch {
    return false;
  }
};
app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header include local health checks and curl.
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use('/uploads', express.static(uploadDir));
app.use('/api/ai', auth, createAiSupportRouter());
app.get('/api/health', (_, res) => res.json({ success: true, message: 'API is running' }));
const ticketId = () => `TKT-2026-${String(Date.now()).slice(-5)}`;
const serviceAuth = [auth, allowRoles('iplanet_service')];
const transitions = { Open: ['Engineer Assigned'], 'Engineer Assigned': ['Engineer Accepted'], 'Engineer Accepted': ['In Progress'], 'In Progress': ['Waiting for Parts', 'Completed'], 'Waiting for Parts': ['In Progress'], Completed: ['Closed'], Closed: [] };
const escalationContacts = { 1: { level: 1, name: 'Service Coordinator', contactName: 'Neha Menon', email: 'service@iplanet.local' }, 2: { level: 2, name: 'Service Manager', contactName: 'Ravi Shah', email: 'manager@iplanet.local' }, 3: { level: 3, name: 'Regional Operations Manager', contactName: 'Kiran Rao', email: 'operations@iplanet.local' } };
function targetHours(priority = 'Medium') { return { Critical: 4, High: 12, Medium: 24, Low: 48 }[priority] || 24; }
async function notifyUsers({ users, company, ticket, device, type, title, message }) { if (!users.length) return; await Notification.insertMany(users.map(user => ({ user: user._id, company, ticket: ticket?._id, device: device?._id, portalRole: user.role, type, title, message, read: false }))); }
async function serviceUsers() { return User.find({ role: 'iplanet_service' }); }
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
    return { available: false, message: AI_SUPPORT_FALLBACK_MESSAGE };
  }
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
    const categories = ['Service', 'Health Camp', 'Buyback', 'E-Waste'];
    if (!categories.includes(data.category) || !data.description?.trim()) throw new Error('Invalid AI request data');
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
  return String(message).split(/\s+/).find(value => /^[A-Za-z0-9-]{6,}$/.test(value) && /[0-9-]/.test(value)) || null;
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
async function evaluateEscalation(ticket, createEvents = false) { if (!ticket.slaTargetAt || ['Completed', 'Closed'].includes(ticket.status)) return ticket; const now = Date.now(); const target = new Date(ticket.slaTargetAt).getTime(); const created = new Date(ticket.createdAt).getTime(); const elapsedPercent = Math.min(100, Math.max(0, ((now - created) / (target - created)) * 100)); const rules = await EscalationRule.find({ isActive: true, $or: [{ priority: 'All' }, { priority: ticket.priority }] }).sort({ slaThreshold: -1 }); const breachRule = rules.find(rule => ['SLA Breached', 'Critical SLA Breach', 'High Priority SLA Breach'].includes(rule.trigger) && elapsedPercent >= rule.slaThreshold); const riskRule = rules.find(rule => ['SLA Approaching', 'SLA At Risk'].includes(rule.trigger) && elapsedPercent >= rule.slaThreshold); const nextStatus = breachRule ? 'SLA Breached' : riskRule ? 'At Risk' : 'Healthy'; if (nextStatus === 'Healthy' || ['SLA Breached', 'Escalated'].includes(ticket.escalationStatus) && nextStatus !== 'SLA Breached') return ticket; const rule = breachRule || riskRule; const level = rule?.level || (nextStatus === 'SLA Breached' && ticket.priority === 'Critical' ? 3 : nextStatus === 'SLA Breached' ? 2 : 1); const reason = nextStatus === 'SLA Breached' ? 'Resolution SLA exceeded' : 'Resolution SLA approaching'; const changed = ticket.slaStatus !== nextStatus || ticket.escalationStatus !== (nextStatus === 'Healthy' ? 'Not Escalated' : nextStatus); ticket.slaStatus = nextStatus; ticket.escalationStatus = nextStatus === 'Healthy' ? 'Not Escalated' : nextStatus; ticket.escalationLevel = level; ticket.escalationReason = reason; ticket.escalatedAt = ticket.escalatedAt || new Date(); await ticket.save(); if (changed && createEvents) { await TicketTimeline.create({ ticketId: ticket._id, status: nextStatus, message: `${reason}. Escalated to Level ${level}.`, updatedBy: 'SLA Monitor', userRole: 'iplanet_service' }); const users = await serviceUsers(); await notifyUsers({ users, company: ticket.companyId, ticket, type: 'SLA_ESCALATION', title: nextStatus === 'SLA Breached' ? 'SLA breached' : 'SLA approaching', message: `Ticket ${ticket.ticketId} is ${nextStatus.toLowerCase()}. ${reason}.` }); const admins = await User.find({ role: 'corporate_admin', companyId: ticket.companyId }); await notifyUsers({ users: admins, company: ticket.companyId, ticket, type: 'SLA_ESCALATION', title: `SLA update for ${ticket.ticketId}`, message: `${ticket.ticketId} is ${nextStatus.toLowerCase()}. ${reason}.` }); } return ticket; }

app.post('/api/auth/login', async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user || user.password !== req.body.password) return res.status(401).json({ message: 'Invalid demo credentials' });
  const token = jwt.sign({ id: user._id, email: user.email, role: user.role, companyId: user.companyId }, process.env.JWT_SECRET || 'local-demo-secret', { expiresIn: '8h' });
  res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, company: user.company, companyId: user.companyId } });
});

const corporateCompany = req => req.user.role === 'corporate_admin' ? { companyId: new mongoose.Types.ObjectId(req.user.companyId) } : {};
app.get('/api/devices', auth, allowRoles('corporate_admin'), async (req, res) => { const query = { ...corporateCompany(req), ...(req.query.search ? { $or: ['assetId', 'serialNumber', 'model', 'employeeName', 'location'].map(field => ({ [field]: { $regex: req.query.search, $options: 'i' } })) } : {}) }; res.json(await Device.find(query).populate('companyId').sort({ assetId: 1 })); });
app.get('/api/devices/serial/:serialNumber', auth, allowRoles('corporate_admin'), async (req, res) => { const device = await Device.findOne({ serialNumber: req.params.serialNumber, ...corporateCompany(req) }); if (!device) return res.status(404).json({ message: 'No device found for that serial number' }); res.json(device); });
app.get('/api/devices/:id', auth, allowRoles('corporate_admin'), async (req, res) => { const device = await Device.findOne({ _id: req.params.id, ...corporateCompany(req) }); if (!device) return res.status(404).json({ message: 'Device not found' }); res.json(device); });
app.get('/api/tickets', auth, allowRoles('corporate_admin'), async (req, res) => { const query = { companyId: req.user.companyId, ...(req.query.status && req.query.status !== 'All' ? { status: req.query.status } : {}) }; res.json(await Ticket.find(query).populate('deviceId').populate('companyId').populate('assignedEngineerId').sort({ createdAt: -1 })); });
app.get('/api/tickets/:id', auth, allowRoles('corporate_admin'), async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }).populate('deviceId').populate('companyId').populate('assignedEngineerId').populate('customerId'); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); await evaluateEscalation(ticket, true); const [timeline, callHistory, aiSupport] = await Promise.all([TicketTimeline.find({ ticketId: ticket._id }).sort({ timestamp: 1 }), CallRecord.find({ ticketId: ticket._id }).sort({ createdAt: -1 }), AITroubleshootingSession.find({ ticketId: ticket._id }).sort({ createdAt: -1 })]); res.json({ ticket, escalation: { status: ticket.escalationStatus, level: ticket.escalationLevel, reason: ticket.escalationReason, responseTarget: ticket.responseTarget, resolutionTarget: ticket.resolutionTarget, slaTargetAt: ticket.slaTargetAt }, escalationContact: escalationContacts[ticket.escalationLevel] || null, timeline, callHistory, aiSupport }); });
app.post('/api/tickets', auth, allowRoles('corporate_admin'), async (req, res) => { const device = await Device.findOne({ _id: req.body.deviceId, companyId: req.user.companyId }); if (!device) return res.status(400).json({ message: 'Valid company device selection is required' }); const createdAt = new Date(); const ticket = await Ticket.create({ ...req.body, ticketId: ticketId(), customerId: req.user.id, companyId: req.user.companyId, deviceId: device._id, status: 'Open', images: [], originalImages: [], annotatedImages: [], responseTarget: '4 business hours', resolutionTarget: `${targetHours(req.body.priority)} hours`, slaTargetAt: new Date(createdAt.getTime() + targetHours(req.body.priority) * 3600000), slaStatus: 'Healthy', escalationStatus: 'Not Escalated' }); await TicketTimeline.create({ ticketId: ticket._id, status: 'Open', message: 'Service request created by Corporate Admin.', updatedBy: 'Corporate Portal', userRole: 'corporate_admin' }); const users = await serviceUsers(); await notifyUsers({ users, company: ticket.companyId, ticket, device, type: 'NEW_SERVICE_REQUEST', title: 'New service request', message: `${ticket.ticketId} was raised for ${device.model}.` }); res.status(201).json(await ticket.populate('deviceId')); });
app.post('/api/tickets/:id/images', auth, allowRoles('corporate_admin'), upload.array('images', 5), async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); const paths = req.files.map(file => `/uploads/${file.filename}`); ticket.images.push(...paths); ticket.originalImages.push(...paths); await ticket.save(); res.json(ticket); });
app.post('/api/tickets/:id/annotated-images', auth, allowRoles('corporate_admin'), upload.array('images', 5), async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); const paths = req.files.map(file => `/uploads/${file.filename}`); ticket.images.push(...paths); ticket.annotatedImages.push(...paths); await ticket.save(); res.json(ticket); });
app.get('/api/tickets/:id/calls', auth, async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }).populate('customerId'); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); res.json(await CallRecord.find({ ticketId: ticket._id }).sort({ createdAt: -1 })); });
app.post('/api/tickets/:id/calls', auth, async (req, res) => { const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.user.companyId }).populate('customerId'); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); const customerPhone = req.body.customerPhone || ticket.customerId?.phone || ticket.companyId?.phone || ''; const record = await CallRecord.create({ ticketId: ticket._id, agentUserId: req.user.id, agentName: req.user.name || 'Service Agent', ticketNumber: ticket.ticketId, customerName: ticket.customerId?.name || ticket.customerId?.company || 'Customer', customerPhone, outcome: req.body.outcome || 'Customer Unavailable', notes: req.body.notes || '', callStatus: req.body.callStatus || 'Call Attempted' }); await TicketTimeline.create({ ticketId: ticket._id, status: 'Call Update', message: `${record.outcome}${record.notes ? `: ${record.notes}` : ''}`, updatedBy: record.agentName, userRole: req.user.role, timestamp: new Date() }); res.status(201).json(record); });
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

  const ticket = ticketId ? await Ticket.findOne({ _id: ticketId, companyId: req.user.companyId }).populate('deviceId') : null;
  if (ticketId && !ticket) return res.status(404).json({ message: 'Ticket not found' });
  const suppliedSerial = !ticket && !deviceId ? serialMention(trimmedMessage) : null;
  const device = ticket?.deviceId || (deviceId ? await Device.findOne({ _id: deviceId, companyId: req.user.companyId }) : await findAuthorizedDeviceBySerial(suppliedSerial, req.user.companyId));
  if (deviceId && !device) return res.status(404).json({ message: 'Device not found' });

  // A missing conversation ID means the customer deliberately started a new
  // chat. Never query MongoDB with an undefined session ID: it can otherwise
  // match legacy documents and resume a later state such as device collection.
  const session = ticketId
    ? (conversationId ? await AITroubleshootingSession.findOne({ _id: conversationId, ticketId: ticket._id }) : await AITroubleshootingSession.findOne({ ticketId: ticket._id }).sort({ createdAt: -1 }))
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
    try {
      const currentFlow = activeSession.issueContext?.flowState || 'initial';
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
        preferredServiceDate: previous.preferredServiceDate || resolveServiceDateIntent(understanding.preferredServiceDateIntent || trimmedMessage).date || null,
        symptoms: [...new Set([...(previous.symptoms || []), ...(understanding.symptoms || [])])]
      };
      if (device) state.deviceId = String(device._id);
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

      if (currentFlow === 'awaiting_troubleshooting_result' && understanding.workflowSignal === 'resolved') {
        flowState = 'completed';
        reply = "Great! I'm glad that fixed the issue. If you need anything else, I'm here to help.";
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
      return res.json({ success: true, message: reply, conversationId: activeSession.sessionId, session: activeSession, requestData: draft ? { ...draft, conversationId: activeSession.sessionId } : null });
    } catch (error) {
      console.error(`[AI ERROR] Stage: Request Understanding Code: ${error.code || 'AI_UNEXPECTED_ERROR'}`);
      activeSession.providerAvailable = false;
      activeSession.providerStatus = 'Unavailable';
      activeSession.status = 'AI unavailable';
      await activeSession.save();
      return res.status(200).json({ success: false, message: AI_SUPPORT_FALLBACK_MESSAGE, conversationId: activeSession.sessionId });
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
app.get('/api/ai/support/request-data/:conversationId', auth, async (req, res) => {
  const session = await AITroubleshootingSession.findOne({ sessionId: req.params.conversationId, customerId: req.user.id });
  if (!session?.preparedRequest) return res.status(404).json({ message: 'No prepared AI request was found.' });
  const device = await Device.findOne({ _id: session.preparedRequest.deviceId, companyId: req.user.companyId });
  if (!device) return res.status(404).json({ message: 'The prepared device is no longer available.' });
  return res.json({ requestData: normalizeAiRequest(session.preparedRequest, device) });
});
app.get('/api/dashboard/stats', auth, allowRoles('corporate_admin'), async (req, res) => { const [totalDevices, tickets, warrantyDevices, amcDevices] = await Promise.all([Device.countDocuments(corporateCompany(req)), Ticket.find(corporateCompany(req)), Device.countDocuments({ ...corporateCompany(req), warrantyStatus: 'Active' }), Device.countDocuments({ ...corporateCompany(req), amcStatus: 'Active' })]); await Promise.all(tickets.map(ticket => evaluateEscalation(ticket, true))); res.json({ totalDevices, openTickets: tickets.filter(t => t.status === 'Open').length, inProgress: tickets.filter(t => t.status === 'In Progress').length, completedTickets: tickets.filter(t => t.status === 'Completed').length, closedTickets: tickets.filter(t => t.status === 'Closed').length, activeEscalations: tickets.filter(t => t.escalationStatus === 'Escalated').length, atRiskTickets: tickets.filter(t => t.escalationStatus === 'At Risk').length, breachedTickets: tickets.filter(t => t.escalationStatus === 'SLA Breached').length, warrantyDevices, amcDevices }); });
async function ticketVolumeByMonth() {
  const rows = await Ticket.aggregate([{ $group: { _id: { $month: '$createdAt' }, tickets: { $sum: 1 } } }, { $sort: { '_id': 1 } }]);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months.map((month, index) => ({ month, tickets: rows.find(row => row._id === index + 1)?.tickets || 0 }));
}
app.get('/api/dashboard/ticket-volume', auth, async (_, res) => res.json(await ticketVolumeByMonth()));
app.get('/api/dashboard/location-distribution', auth, allowRoles('corporate_admin'), async (req, res) => res.json(await Device.aggregate([{ $match: corporateCompany(req) }, { $group: { _id: '$location', value: { $sum: 1 } } }, { $project: { _id: 0, name: '$_id', value: 1 } }])));
app.get('/api/profile', auth, allowRoles('corporate_admin'), async (req, res) => { const user = await User.findById(req.user.id).populate('companyId').select('-password'); const numberOfDevices = await Device.countDocuments(corporateCompany(req)); res.json({ ...user.toObject(), primaryLocation: user.companyId?.location || 'Chennai', numberOfDevices }); });
app.get('/api/corporate/notifications', auth, allowRoles('corporate_admin'), async (req, res) => res.json(await Notification.find({ user: req.user.id, company: req.user.companyId }).populate('ticket').populate('device').sort({ createdAt: -1 })));
app.get('/api/corporate/notifications/unread-count', auth, allowRoles('corporate_admin'), async (req, res) => res.json({ count: await Notification.countDocuments({ user: req.user.id, company: req.user.companyId, read: false }) }));
app.patch('/api/corporate/notifications/:id/read', auth, allowRoles('corporate_admin'), async (req, res) => { const notification = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user.id, company: req.user.companyId }, { read: true }, { new: true }); if (!notification) return res.status(404).json({ message: 'Notification not found' }); res.json(notification); });
app.patch('/api/corporate/notifications/read-all', auth, allowRoles('corporate_admin'), async (req, res) => { await Notification.updateMany({ user: req.user.id, company: req.user.companyId, read: false }, { read: true }); res.json({ ok: true }); });
app.patch('/api/corporate/devices/:id/assign', auth, allowRoles('corporate_admin'), async (req, res) => { const device = await Device.findOne({ _id: req.params.id, companyId: req.user.companyId }); if (!device) return res.status(404).json({ message: 'Device not found in your company inventory' }); device.employeeName = req.body.employeeName; device.employeeId = req.body.employeeId; device.department = req.body.department; device.location = req.body.location; device.deviceAllocationStatus = 'Assigned'; await device.save(); await Notification.updateMany({ user: req.user.id, company: req.user.companyId, device: device._id, type: 'NEW_DEVICE' }, { read: true }); res.json(device); });

async function serviceTicket(id) { return Ticket.findById(id).populate('customerId').populate('companyId').populate('serviceCentreId').populate('deviceId').populate('assignedEngineerId'); }
async function addTimeline(ticket, status, message, user) { ticket.status = status; ticket.updatedAt = new Date(); await ticket.save(); return TicketTimeline.create({ ticketId: ticket._id, status, message, updatedBy: user.name, userRole: user.role, timestamp: new Date() }); }
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
  if (req.query.date) query.createdAt = { $gte: new Date(req.query.date), $lt: new Date(new Date(req.query.date).getTime() + 86400000) };
  const tickets = await Ticket.find(query).populate('customerId').populate('companyId').populate('deviceId').populate('assignedEngineerId').sort({ createdAt: -1 });
  const search = req.query.search?.toLowerCase();
  await Promise.all(tickets.map(ticket => evaluateEscalation(ticket, true)));
  res.json(search ? tickets.filter(ticket => JSON.stringify(ticket).toLowerCase().includes(search)) : tickets);
});
app.get('/api/iplanet/tickets/:id', ...serviceAuth, async (req, res) => { const ticket = await serviceTicket(req.params.id); if (!ticket) return res.status(404).json({ message: 'Service ticket not found' }); await evaluateEscalation(ticket, true); const [timeline, callHistory, aiSupport] = await Promise.all([TicketTimeline.find({ ticketId: ticket._id }).sort({ timestamp: 1 }), CallRecord.find({ ticketId: ticket._id }).sort({ createdAt: -1 }), AITroubleshootingSession.find({ ticketId: ticket._id }).sort({ createdAt: -1 })]); res.json({ ticket, coverage: { warrantyStatus: ticket.deviceId?.warrantyStatus, warrantyExpiry: ticket.deviceId?.warrantyExpiry, amcStatus: ticket.deviceId?.amcStatus, amcExpiry: ticket.deviceId?.amcExpiry, status: ticket.deviceId?.warrantyStatus === 'Active' || ticket.deviceId?.amcStatus === 'Active' ? 'Covered' : 'Not Covered', entitlements: ticket.deviceId?.warrantyStatus === 'Active' || ticket.deviceId?.amcStatus === 'Active' ? ['Repair', 'Parts Replacement', 'Remote Support'] : [] }, escalationContact: escalationContacts[ticket.escalationLevel] || null, timeline, callHistory, aiSupport }); });
app.get('/api/iplanet/companies', ...serviceAuth, async (_, res) => res.json(await Company.find().sort({ name: 1 })));
app.post('/api/iplanet/companies', ...serviceAuth, async (req, res) => { const { name, location, contactName, contactEmail, phone } = req.body; if (!name?.trim() || !location?.trim()) return res.status(400).json({ message: 'Corporate name and location are required' }); try { const company = await Company.create({ name: name.trim(), location: location.trim(), contactName, contactEmail, phone, companyId: `CO-${Date.now()}` }); res.status(201).json(company); } catch (error) { if (error.code === 11000) return res.status(409).json({ message: 'A Corporate with that name already exists' }); throw error; } });
app.get('/api/iplanet/service-centres', ...serviceAuth, async (_, res) => res.json(await ServiceCentre.find({ status: 'Active' }).sort({ name: 1 })));
app.post('/api/iplanet/service-centres', ...serviceAuth, async (req, res) => { const { name, location, address, city, state, contactNumber, email, status } = req.body; if (!name?.trim() || !location?.trim()) return res.status(400).json({ message: 'Service Centre name and location are required' }); try { res.status(201).json(await ServiceCentre.create({ name: name.trim(), location: location.trim(), address, city, state, contactNumber, email, status: status || 'Active' })); } catch (error) { if (error.code === 11000) return res.status(409).json({ message: 'A Service Centre with that name already exists' }); throw error; } });
app.get('/api/iplanet/engineers', ...serviceAuth, async (_, res) => { const engineers = await Engineer.find().populate('userId'); const tickets = await Ticket.find({ assignedEngineerId: { $ne: null }, status: { $nin: ['Closed'] } }); res.json(engineers.map(engineer => ({ ...engineer.toObject(), assignedTicketCount: tickets.filter(ticket => String(ticket.assignedEngineerId) === String(engineer._id)).length }))); });
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
async function engineerAction(req, res, status, message, title = `${status} update`) { const ticket = await serviceTicket(req.params.id); if (!ticket) return res.status(404).json({ message: 'Service ticket not found' }); if (!ticket.assignedEngineerId) return res.status(409).json({ message: 'Assign an engineer before updating this ticket' }); if (!transitions[ticket.status]?.includes(status)) return res.status(409).json({ message: `Cannot move a ${ticket.status} ticket to ${status}` }); const updateMessage = req.body.note?.trim() || message || `${status} update recorded.`; await addTimeline(ticket, status, updateMessage, req.user); await notifyTicketUpdate(ticket, ticket.deviceId, 'TICKET_UPDATE', title, `${ticket.ticketId}: ${updateMessage}`); await evaluateEscalation(ticket, true); res.json(await serviceTicket(ticket._id)); }
app.post('/api/iplanet/tickets/:id/accept', ...serviceAuth, async (req, res) => engineerAction(req, res, 'Engineer Accepted', 'Engineer accepted the service assignment.'));
app.post('/api/iplanet/tickets/:id/start', ...serviceAuth, async (req, res) => engineerAction(req, res, 'In Progress', 'Work started on the service request.', 'Work started'));
app.post('/api/iplanet/tickets/:id/waiting-parts', ...serviceAuth, async (req, res) => engineerAction(req, res, 'Waiting for Parts', 'Waiting for replacement parts.', 'Waiting for parts'));
app.post('/api/iplanet/tickets/:id/complete', ...serviceAuth, async (req, res) => engineerAction(req, res, 'Completed', 'Repair completed and tested successfully.', 'Repair completed'));
app.post('/api/iplanet/tickets/:id/close', ...serviceAuth, async (req, res) => engineerAction(req, res, 'Closed', 'Ticket closed after service completion.', 'Ticket closed'));
app.post('/api/iplanet/tickets/:id/update', ...serviceAuth, async (req, res) => engineerAction(req, res, req.body.status, req.body.note || 'Service update recorded.'));
app.get('/api/iplanet/dashboard', ...serviceAuth, async (_, res) => { const tickets = await Ticket.find(); await Promise.all(tickets.map(ticket => evaluateEscalation(ticket, true))); const count = status => tickets.filter(ticket => ticket.status === status).length; res.json({ stats: { newRequests: count('Open'), unassigned: tickets.filter(ticket => !ticket.assignedEngineerId).length, assigned: count('Engineer Assigned') + count('Engineer Accepted'), inProgress: count('In Progress'), waitingParts: count('Waiting for Parts'), completed: count('Completed'), closed: count('Closed'), activeEscalations: tickets.filter(ticket => ticket.escalationStatus === 'Escalated').length, atRisk: tickets.filter(ticket => ticket.escalationStatus === 'At Risk').length, breached: tickets.filter(ticket => ticket.escalationStatus === 'SLA Breached').length }, volume: await ticketVolumeByMonth(), locations: await Ticket.aggregate([{ $group: { _id: '$location', value: { $sum: 1 } } }, { $project: { _id: 0, name: '$_id', value: 1 } }]) }); });
app.get('/api/iplanet/reports', ...serviceAuth, async (_, res) => { const tickets = await Ticket.find().populate('deviceId'); const group = key => Object.entries(tickets.reduce((result, ticket) => { const value = key === 'deviceType' ? ticket.deviceId?.deviceType : ticket[key]; result[value || 'Other'] = (result[value || 'Other'] || 0) + 1; return result; }, {})).map(([name, value]) => ({ name, value })); res.json({ total: tickets.length, open: tickets.filter(t => t.status === 'Open').length, completed: tickets.filter(t => t.status === 'Completed').length, closed: tickets.filter(t => t.status === 'Closed').length, averageClosureTat: '2.4 days', locations: group('location'), deviceTypes: group('deviceType'), issueTypes: group('issueType') }); });
app.get('/api/iplanet/notifications', ...serviceAuth, async (req, res) => res.json(await Notification.find({ user: req.user.id, portalRole: 'iplanet_service' }).populate('ticket').populate('device').sort({ createdAt: -1 })));
app.get('/api/iplanet/notifications/unread-count', ...serviceAuth, async (req, res) => res.json({ count: await Notification.countDocuments({ user: req.user.id, portalRole: 'iplanet_service', read: false }) }));
app.patch('/api/iplanet/notifications/:id/read', ...serviceAuth, async (req, res) => { const notification = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user.id, portalRole: 'iplanet_service' }, { read: true }, { new: true }); if (!notification) return res.status(404).json({ message: 'Notification not found' }); res.json(notification); });
app.patch('/api/iplanet/notifications/read-all', ...serviceAuth, async (req, res) => { await Notification.updateMany({ user: req.user.id, portalRole: 'iplanet_service', read: false }, { read: true }); res.json({ ok: true }); });
app.get('/api/escalation-matrix', auth, async (_, res) => res.json(Object.values(escalationContacts).map(contact => ({ ...contact, trigger: contact.level === 1 ? 'SLA approaching' : contact.level === 2 ? 'SLA breached' : 'Critical SLA breach' }))));
app.get('/api/iplanet/escalation-rules', ...serviceAuth, async (_, res) => res.json(await EscalationRule.find().sort({ level: 1, slaThreshold: 1 })));
app.post('/api/iplanet/escalation-rules', ...serviceAuth, async (req, res) => { const { name, level, trigger, priority, slaThreshold, action, isActive } = req.body; if (!name?.trim() || !level || !trigger || !action?.trim() || !Number.isFinite(Number(slaThreshold)) || Number(slaThreshold) < 0 || Number(slaThreshold) > 100) return res.status(400).json({ message: 'Rule name, level, trigger, valid SLA threshold, and action are required' }); res.status(201).json(await EscalationRule.create({ name: name.trim(), level: Number(level), trigger, priority: priority || 'All', slaThreshold: Number(slaThreshold), action: action.trim(), isActive: isActive !== false })); });
app.patch('/api/iplanet/escalation-rules/:id', ...serviceAuth, async (req, res) => { const rule = await EscalationRule.findByIdAndUpdate(req.params.id, { ...req.body, ...(req.body.slaThreshold !== undefined ? { slaThreshold: Number(req.body.slaThreshold) } : {}) }, { new: true, runValidators: true }); if (!rule) return res.status(404).json({ message: 'Escalation rule not found' }); res.json(rule); });
app.get('/api/coverage', auth, async (req, res) => { const query = req.user.role === 'corporate_admin' ? { companyId: req.user.companyId } : {}; const devices = await Device.find(query).populate('companyId').sort({ model: 1 }); const covered = devices.map(device => ({ ...device.toObject(), coverageStatus: device.warrantyStatus === 'Active' || device.amcStatus === 'Active' ? 'Covered' : 'Not Covered', entitlements: device.warrantyStatus === 'Active' || device.amcStatus === 'Active' ? ['Repair', 'Parts Replacement', 'Remote Support'] : [] })); res.json({ summary: { total: covered.length, warrantyActive: covered.filter(device => device.warrantyStatus === 'Active').length, amcActive: covered.filter(device => device.amcStatus === 'Active').length, expiringSoon: covered.filter(device => device.warrantyStatus === 'Expiring Soon' || device.amcStatus === 'Expiring Soon').length, expired: covered.filter(device => device.warrantyStatus === 'Expired' || device.amcStatus === 'Expired').length }, devices: covered }); });
app.get('/api/tickets/:id/escalation', auth, async (req, res) => { const ticket = await Ticket.findById(req.params.id); if (!ticket) return res.status(404).json({ message: 'Ticket not found' }); await evaluateEscalation(ticket, true); res.json({ escalation: { status: ticket.escalationStatus, level: ticket.escalationLevel, reason: ticket.escalationReason, escalatedAt: ticket.escalatedAt, slaStatus: ticket.slaStatus, responseTarget: ticket.responseTarget, resolutionTarget: ticket.resolutionTarget, slaTargetAt: ticket.slaTargetAt }, escalationContact: escalationContacts[ticket.escalationLevel] || null, history: await TicketTimeline.find({ ticketId: ticket._id, status: { $in: ['At Risk', 'SLA Breached', 'Escalated'] } }).sort({ timestamp: 1 }) }); });
app.get('/api/iplanet/device-master', ...serviceAuth, async (_, res) => res.json(await DeviceMaster.find().sort({ serialNumber: 1 })));
app.get('/api/iplanet/device-master/:serialNumber', ...serviceAuth, async (req, res) => { const device = await DeviceMaster.findOne({ serialNumber: req.params.serialNumber }); if (!device) return res.status(404).json({ message: 'Device not found. Please verify the serial number.' }); res.json(device); });
app.post('/api/iplanet/devices/enroll', ...serviceAuth, async (req, res) => { const master = await DeviceMaster.findOne({ serialNumber: req.body.serialNumber }); const selectedEntityType = req.body.selectedEntityType; const selectedEntityId = req.body.selectedEntityId; const company = selectedEntityType === 'corporate' ? await Company.findById(selectedEntityId) : null; const centre = selectedEntityType === 'service_centre' ? await ServiceCentre.findById(selectedEntityId) : null; if (!master) return res.status(404).json({ message: 'Device not found. Please verify the serial number.' }); if (!['corporate', 'service_centre'].includes(selectedEntityType) || !selectedEntityId || (!company && !centre)) return res.status(400).json({ message: 'Select a valid Corporate or Service Centre' }); let device = await Device.findOne({ serialNumber: master.serialNumber }); const values = { selectedEntityId, selectedEntityType, ...(company ? { companyId: company._id, location: company.location } : { location: centre.location }), employeeName: null, employeeId: null, department: null, deviceAllocationStatus: 'Unassigned' }; if (device) { Object.assign(device, values); await device.save(); } else { device = await Device.create({ serialNumber: master.serialNumber, deviceType: master.deviceType, model: master.model, assetId: master.assetId, purchaseDate: master.purchaseDate, warrantyStatus: master.warrantyStatus, warrantyExpiry: master.warrantyExpiry, amcStatus: master.amcStatus, amcExpiry: master.amcExpiry, ...values, deviceStatus: 'In Use' }); } const admins = company ? await User.find({ role: 'corporate_admin', companyId: company._id }) : []; await Notification.insertMany(admins.map(admin => ({ user: admin._id, company: company._id, type: 'NEW_DEVICE', title: 'New Device Added', message: `A new ${device.model} has been added to your organization.`, device: device._id, read: false }))); res.status(201).json(await device.populate('companyId')); });
app.use((error, _, res, __) => res.status(400).json({ message: error.message || 'Request failed' }));
const port = process.env.PORT || 5000;
async function ensureEscalationRules() { const defaults = [{ name: 'SLA Approaching', level: 1, trigger: 'SLA Approaching', priority: 'All', slaThreshold: 80, action: 'Notify Service Coordinator' }, { name: 'SLA Breach', level: 2, trigger: 'SLA Breached', priority: 'All', slaThreshold: 100, action: 'Escalate to Service Manager' }, { name: 'Critical SLA Breach', level: 3, trigger: 'Critical SLA Breach', priority: 'Critical', slaThreshold: 100, action: 'Escalate to Regional Operations Manager' }]; if (await EscalationRule.countDocuments() === 0) await EscalationRule.insertMany(defaults); }
async function ensureServiceCentres() { if (await ServiceCentre.countDocuments() === 0) await ServiceCentre.insertMany(['Chennai', 'Coimbatore', 'Bengaluru', 'Madurai'].map(location => ({ name: `${location} Service Centre`, location, status: 'Active' }))); }
async function ensureDemoEnrollmentDevices() {
  await Promise.all(demoEnrollmentDevices.map(device => DeviceMaster.updateOne({ serialNumber: device.serialNumber }, { $setOnInsert: device }, { upsert: true })));
}
async function ensureDemoAccounts() {
  let company = await Company.findOne({ name: 'Demo Corporation' });
  if (!company) company = await Company.create({ name: 'Demo Corporation', companyId: 'CO-003', contactName: 'Corporate Admin', contactEmail: 'admin@corporate.local', phone: '+91 90000 00000', location: 'Chennai' });
  await User.findOneAndUpdate(
    { email: 'admin@corporate.local' },
    { $setOnInsert: { name: 'Corporate Admin', email: 'admin@corporate.local', password: 'Demo@123', role: 'corporate_admin', company: company.name, companyId: company._id, phone: company.phone } },
    { upsert: true, new: true }
  );
  await User.findOneAndUpdate(
    { email: 'service@iplanet.local' },
    { $setOnInsert: { name: 'iPlanet Service', email: 'service@iplanet.local', password: 'Demo@123', role: 'iplanet_service', company: 'iPlanet Service Desk', phone: '+91 90000 00002' } },
    { upsert: true, new: true }
  );
}
 
mongoose.connect(process.env.MONGODB_URI).then(async () => { await ensureDemoAccounts(); await ensureDemoEnrollmentDevices(); await ensureEscalationRules(); await ensureServiceCentres(); app.listen(port, '0.0.0.0', () => console.log(`API running at http://localhost:${port}`)); }).catch(error => { console.error('MongoDB connection failed:', error.message); process.exit(1); });
