import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({ name: String, email: { type: String, unique: true }, password: { type: String, select: false }, role: { type: String, default: 'corporate_admin' }, company: String, companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }, phone: String, gstNumber: String,
  // B2C escalation access: 'b2c_admin' or a workflow level key (see b2c/b2cDefaults.js). Held by
  // 'b2c_staff' accounts (B2C only) or by iplanet_service accounts that also work B2C escalations.
  // Unset for every B2B-only account. Regions limit which level queues the user sees; empty means all.
  b2cRole: { type: String, default: null }, b2cRegions: { type: [String], default: undefined } });
const companySchema = new mongoose.Schema({ name: { type: String, unique: true }, companyId: { type: String, unique: true }, contactName: String, contactEmail: String, phone: String, location: String });
const serviceCentreSchema = new mongoose.Schema({
  serviceCentreId: { type: String, unique: true, sparse: true },
  name: { type: String, unique: true },
  location: { type: String, required: true },
  address: String,
  city: String,
  state: String,
  contactNumber: String,
  email: String,
  status: { type: String, default: 'Active' },
}, { timestamps: true });
const deviceSchema = new mongoose.Schema({ assetId: String, serialNumber: { type: String, unique: true }, deviceType: String, model: String, companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, selectedEntityId: { type: mongoose.Schema.Types.ObjectId }, selectedEntityType: { type: String, enum: ['corporate', 'service_centre'] }, employeeName: String, employeeId: String, department: String, location: String, purchaseDate: Date, warrantyStatus: String, warrantyExpiry: Date, amcStatus: String, amcExpiry: Date, deviceStatus: String, deviceAllocationStatus: { type: String, enum: ['Unassigned', 'Assigned'], default: 'Unassigned' }, lastServiceDate: Date, installationDate: Date, serviceIntervalMonths: { type: Number, min: 1, max: 60 }, nextServiceDate: Date });
// Asset IDs are unique within an organization; devices without one are not constrained.
deviceSchema.index({ companyId: 1, assetId: 1 }, { unique: true, partialFilterExpression: { assetId: { $type: 'string' } } });
const deviceMasterSchema = new mongoose.Schema({ serialNumber: { type: String, unique: true }, deviceType: String, model: String, assetId: String, purchaseDate: Date, warrantyStatus: String, warrantyExpiry: Date, amcStatus: String, amcExpiry: Date });
const engineerSchema = new mongoose.Schema({ name: String, employeeId: { type: String, unique: true }, email: { type: String, unique: true }, phone: String, location: String, status: { type: String, default: 'Available' }, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } });
const ticketSchema = new mongoose.Schema({ ticketId: { type: String, unique: true }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }, deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, category: String, issueType: String, description: String, images: [String], originalImages: [String], annotatedImages: [String], location: String, preferredServiceDate: Date, deviceCount: Number, closedAt: Date, priority: String, status: { type: String, default: 'Open' }, assignedEngineer: String, assignedEngineerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Engineer' }, assignedAt: Date, expectedTAT: String, responseTarget: String, resolutionTarget: String, slaTargetAt: Date, slaStatus: { type: String, enum: ['Healthy', 'At Risk', 'Escalated', 'SLA Breached', 'Resolved'], default: 'Healthy' }, escalationLevel: { type: Number, default: 0 }, escalationStatus: { type: String, enum: ['Not Escalated', 'At Risk', 'Escalated', 'SLA Breached', 'Resolved'], default: 'Not Escalated' }, escalationReason: String, escalatedAt: Date, serviceFollowUpId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceFollowUp' } }, { timestamps: true });
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// One proactive-service cycle for one device: the recommended service date the
// cycle is about, what the service team and the corporate customer did about
// it, and which notifications have already been sent for it.
const serviceFollowUpSchema = new mongoose.Schema({
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
  serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre', index: true },
  dueDate: { type: String, required: true, match: DATE_ONLY },
  intervalMonths: Number,
  basis: String,
  stage: { type: String, enum: ['Open', 'Contacted', 'Remind Later', 'Scheduled', 'In Service', 'Completed', 'Not Required', 'Superseded'], default: 'Open', index: true },
  contactLog: [{ at: { type: Date, default: Date.now }, byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, byName: String, method: String, outcome: String, notes: String }],
  customerResponse: { type: { type: String }, at: Date, byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, byName: String, reason: String, notes: String },
  followUpDate: { type: String, match: DATE_ONLY },
  followUpSetBy: { type: String, enum: ['iplanet_service', 'corporate_admin'] },
  scheduledDate: { type: String, match: DATE_ONLY },
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' },
  completedAt: Date,
  notRequiredReason: String,
  closedAt: Date,
  notifiedStates: { type: [String], default: [] }
}, { timestamps: true });
serviceFollowUpSchema.index({ deviceId: 1, dueDate: 1 }, { unique: true });
const escalationRuleSchema = new mongoose.Schema({ name: { type: String, required: true }, level: { type: Number, min: 1, max: 3, required: true }, trigger: { type: String, required: true }, priority: { type: String, default: 'All' }, slaThreshold: { type: Number, min: 0, max: 100, required: true }, action: { type: String, required: true }, isActive: { type: Boolean, default: true } }, { timestamps: true });
// A review covers one calendar month (period 'YYYY-MM') of a company's closed requests.
// Older reviews were for a single request and carry ticketId instead of period.
const reviewSchema = new mongoose.Schema({ period: String, ticketIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }], serviceCentreIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }], ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }, corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre', index: true }, deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, engineerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Engineer' }, rating: { type: Number, required: true, min: 1, max: 5 }, comment: { type: String, required: true, trim: true, maxlength: 2000 } }, { timestamps: true });
reviewSchema.index({ ticketId: 1 }, { unique: true, partialFilterExpression: { ticketId: { $exists: true } } });
reviewSchema.index({ corporateId: 1, period: 1 }, { unique: true, partialFilterExpression: { period: { $exists: true } } });
reviewSchema.index({ serviceCentreIds: 1, createdAt: -1 });
reviewSchema.index({ corporateId: 1, createdAt: -1 });
reviewSchema.index({ serviceCentreId: 1, createdAt: -1 });
const googleBusinessIntegrationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  portalRole: { type: String, required: true, enum: ['iplanet_service'], default: 'iplanet_service' },
  provider: { type: String, required: true, default: 'google-business-profile' },
  accountId: { type: String, default: null },
  accountName: { type: String, default: null },
  accountDisplayName: { type: String, default: null },
  accessToken: { type: String, default: null },
  refreshToken: { type: String, default: null },
  tokenType: { type: String, default: 'Bearer' },
  expiresAt: { type: Date, default: null },
  connectedAt: { type: Date, default: Date.now },
  lastSyncedAt: { type: Date, default: null },
  status: { type: String, default: 'connected', enum: ['connected', 'error', 'disconnected', 'reconnect_required'] },
  grantedScope: { type: String, default: null },
  // Outcome of the latest Google API call, so the portal can explain e.g.
  // "access pending" (zero quota) without calling Google again.
  accessState: { type: String, default: 'unknown', enum: ['unknown', 'granted', 'pending', 'error'] },
  lastErrorCategory: { type: String, default: null },
  lastErrorMessage: { type: String, default: null },
  lastErrorAt: { type: Date, default: null },
  lastCheckedAt: { type: Date, default: null },
  notificationAccountName: { type: String, default: null },
  notificationTopic: { type: String, default: null },
  notificationsEnabledAt: { type: Date, default: null }
}, { timestamps: true });
googleBusinessIntegrationSchema.index({ provider: 1 }, { unique: true, name: 'provider_1' });
// Sync metadata only. Google review content is never stored here.
const googleBusinessLocationMappingSchema = new mongoose.Schema({
  serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre', required: true, index: true },
  locationName: { type: String, required: true },
  locationDisplayName: { type: String, default: '' },
  accountName: { type: String, default: '' },
  serviceCentreName: { type: String, default: '' },
  mapsUri: { type: String, default: null },
  mappedAt: { type: Date, default: Date.now },
  lastReviewSyncAt: { type: Date, default: null },
  lastSyncedReviewCount: { type: Number, default: 0 },
  lastSyncAttemptAt: { type: Date, default: null },
  syncStatus: { type: String, default: 'never', enum: ['never', 'ok', 'error', 'pending'] },
  lastErrorCategory: { type: String, default: null },
  nextRetryAt: { type: Date, default: null },
  lastNotificationAt: { type: Date, default: null }
}, { timestamps: true });
googleBusinessLocationMappingSchema.index({ serviceCentreId: 1, locationName: 1 }, { unique: true, name: 'serviceCentre_locationName_unique' });
// One record per Pub/Sub delivery, used to make processing idempotent. Holds
// resource names and event type only, and expires after seven days.
export const GOOGLE_NOTIFICATION_RECEIPT_TTL_SECONDS = 7 * 24 * 60 * 60;
const googleBusinessNotificationReceiptSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true },
  eventKey: { type: String, default: undefined },
  type: String,
  location: String,
  status: { type: String, enum: ['processing', 'processed', 'ignored', 'failed'], default: 'processing' },
  outcome: String,
  receivedAt: { type: Date, default: Date.now }
});
googleBusinessNotificationReceiptSchema.index({ eventKey: 1 }, { unique: true, sparse: true });
googleBusinessNotificationReceiptSchema.index({ receivedAt: 1 }, { expireAfterSeconds: GOOGLE_NOTIFICATION_RECEIPT_TTL_SECONDS });
const notificationSchema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }, portalRole: String, type: String, priority: { type: String, enum: ['normal', 'high'], default: 'normal' }, title: String, message: String, ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }, device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, reviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Review' }, action: { type: Object, default: null }, read: { type: Boolean, default: false } }, { timestamps: true });
const timelineSchema = new mongoose.Schema({ ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }, status: String, message: String, note: String, updatedBy: String, userRole: String, timestamp: { type: Date, default: Date.now } });
const callRecordSchema = new mongoose.Schema({ ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true }, agentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, agentName: String, ticketNumber: String, customerName: String, customerPhone: String, outcome: { type: String, enum: ['Issue Resolved Remotely', 'Customer Needs Further Assistance', 'Engineer Visit Required', 'Customer Unavailable', 'Call Back Required'], default: 'Customer Unavailable' }, notes: String, callStatus: { type: String, default: 'Call Attempted' } }, { timestamps: true });
const aiSupportSessionSchema = new mongoose.Schema({ ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, preparedRequest: { type: Object }, sessionId: { type: String, unique: true, required: true }, issueContext: { type: Object, default: {} }, messages: [{ role: { type: String, enum: ['user', 'assistant'], required: true }, content: { type: String, required: true }, timestamp: { type: Date, default: Date.now } }], troubleshootingSteps: [{ step: String, outcome: String, timestamp: { type: Date, default: Date.now } }], customerResponses: [{ response: String, timestamp: { type: Date, default: Date.now } }], result: { type: String, default: 'In Progress' }, status: { type: String, default: 'In Progress' }, escalationStatus: { type: String, enum: ['Not Escalated', 'Recommended Service Assistance', 'Resolved'], default: 'Not Escalated' }, providerAvailable: { type: Boolean, default: false }, providerStatus: String, feedback: { promptedAt: Date, rating: { type: Number, min: 1, max: 5 }, comment: { type: String, trim: true, maxlength: 2000 }, submittedAt: Date } }, { timestamps: true });
// MongoDB has no auto-increment, so sequence numbers come from an atomic $inc
// on a per-key counter document.
const counterSchema = new mongoose.Schema({ key: { type: String, required: true, unique: true }, seq: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', counterSchema);
const customerSchema = new mongoose.Schema({
  customerId: { type: Number, unique: true, immutable: true },
  name: { type: String, required: true, trim: true },
  mobileNumber: { type: String, required: true, trim: true, match: /^\+?[0-9]{10,15}$/ },
  email: { type: String, trim: true, lowercase: true, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  deviceSerialNumber: { type: String, required: true, trim: true, index: true },
}, { timestamps: true });
// Runs after validation, so a rejected customer doesn't use up a number.
customerSchema.pre('save', async function assignCustomerId() {
  if (!this.isNew || this.customerId != null) return;
  const counter = await Counter.findOneAndUpdate({ key: 'customer' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  this.customerId = counter.seq;
});
customerSchema.index({ mobileNumber: 1 });
// Indexes for the queries every portal page runs (lists by company, status,
// device, engineer, recipient and time).
deviceSchema.index({ companyId: 1 });
ticketSchema.index({ companyId: 1, createdAt: -1 });
ticketSchema.index({ status: 1, createdAt: -1 });
ticketSchema.index({ deviceId: 1, status: 1 });
ticketSchema.index({ assignedEngineerId: 1, status: 1 });
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, read: 1 });
timelineSchema.index({ ticketId: 1, timestamp: 1 });
timelineSchema.index({ timestamp: -1 });
timelineSchema.index({ status: 1, timestamp: -1 });
// Self-service sign-up requests. Kept apart from User so a request can never sign in:
// an iPlanet Service user approves it, choosing the organization, and only then is a
// corporate_admin User created. Only one pending request may exist per email.
const accountRequestSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true },
  organization: { type: String, required: true },
  gstNumber: { type: String, required: true },
  passwordHash: { type: String, select: false },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
accountRequestSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
accountRequestSchema.index({ status: 1, createdAt: -1 });

export const User = mongoose.model('User', userSchema);
export const Company = mongoose.model('Company', companySchema);
export const ServiceCentre = mongoose.model('ServiceCentre', serviceCentreSchema);
export const Device = mongoose.model('Device', deviceSchema);
export const DeviceMaster = mongoose.model('DeviceMaster', deviceMasterSchema);
export const Engineer = mongoose.model('Engineer', engineerSchema);
export const Ticket = mongoose.model('Ticket', ticketSchema);
export const TicketTimeline = mongoose.model('TicketTimeline', timelineSchema);
export const Review = mongoose.model('Review', reviewSchema);
export const GoogleBusinessIntegration = mongoose.model('GoogleBusinessIntegration', googleBusinessIntegrationSchema);
export const GoogleBusinessLocationMapping = mongoose.model('GoogleBusinessLocationMapping', googleBusinessLocationMappingSchema);
export const GoogleBusinessNotificationReceipt = mongoose.model('GoogleBusinessNotificationReceipt', googleBusinessNotificationReceiptSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const EscalationRule = mongoose.model('EscalationRule', escalationRuleSchema);
export const ServiceFollowUp = mongoose.model('ServiceFollowUp', serviceFollowUpSchema);
export const CallRecord = mongoose.model('CallRecord', callRecordSchema);
export const AITroubleshootingSession = mongoose.model('AITroubleshootingSession', aiSupportSessionSchema);
export const AccountRequest = mongoose.model('AccountRequest', accountRequestSchema);
export const Customer = mongoose.model('Customer', customerSchema);
