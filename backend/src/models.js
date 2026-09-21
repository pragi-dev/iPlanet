import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({ name: String, email: { type: String, unique: true }, password: String, role: { type: String, default: 'corporate_admin' }, company: String, companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }, phone: String });
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
const deviceSchema = new mongoose.Schema({ assetId: String, serialNumber: { type: String, unique: true }, deviceType: String, model: String, companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, selectedEntityId: { type: mongoose.Schema.Types.ObjectId }, selectedEntityType: { type: String, enum: ['corporate', 'service_centre'] }, employeeName: String, employeeId: String, department: String, location: String, purchaseDate: Date, warrantyStatus: String, warrantyExpiry: Date, amcStatus: String, amcExpiry: Date, deviceStatus: String, deviceAllocationStatus: { type: String, enum: ['Unassigned', 'Assigned'], default: 'Unassigned' }, lastServiceDate: Date });
const deviceMasterSchema = new mongoose.Schema({ serialNumber: { type: String, unique: true }, deviceType: String, model: String, assetId: String, purchaseDate: Date, warrantyStatus: String, warrantyExpiry: Date, amcStatus: String, amcExpiry: Date });
const engineerSchema = new mongoose.Schema({ name: String, employeeId: { type: String, unique: true }, email: { type: String, unique: true }, phone: String, location: String, status: { type: String, default: 'Available' }, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } });
const ticketSchema = new mongoose.Schema({ ticketId: { type: String, unique: true }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }, deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, category: String, issueType: String, description: String, images: [String], originalImages: [String], annotatedImages: [String], location: String, preferredServiceDate: Date, priority: String, status: { type: String, default: 'Open' }, assignedEngineer: String, assignedEngineerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Engineer' }, assignedAt: Date, expectedTAT: String, responseTarget: String, resolutionTarget: String, slaTargetAt: Date, slaStatus: { type: String, enum: ['Healthy', 'At Risk', 'Escalated', 'SLA Breached', 'Resolved'], default: 'Healthy' }, escalationLevel: { type: Number, default: 0 }, escalationStatus: { type: String, enum: ['Not Escalated', 'At Risk', 'Escalated', 'SLA Breached', 'Resolved'], default: 'Not Escalated' }, escalationReason: String, escalatedAt: Date }, { timestamps: true });
const escalationRuleSchema = new mongoose.Schema({ name: { type: String, required: true }, level: { type: Number, min: 1, max: 3, required: true }, trigger: { type: String, required: true }, priority: { type: String, default: 'All' }, slaThreshold: { type: Number, min: 0, max: 100, required: true }, action: { type: String, required: true }, isActive: { type: Boolean, default: true } }, { timestamps: true });
const reviewSchema = new mongoose.Schema({ ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true, unique: true, index: true }, corporateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre', index: true }, deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, engineerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Engineer' }, rating: { type: Number, required: true, min: 1, max: 5 }, comment: { type: String, required: true, trim: true, maxlength: 2000 } }, { timestamps: true });
reviewSchema.index({ corporateId: 1, createdAt: -1 });
reviewSchema.index({ serviceCentreId: 1, createdAt: -1 });
const googleBusinessIntegrationSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  accountId: { type: String, default: null },
  accountName: { type: String, default: null },
  accountDisplayName: { type: String, default: null },
  accessToken: { type: String, default: null },
  refreshToken: { type: String, default: null },
  tokenType: { type: String, default: 'Bearer' },
  expiresAt: { type: Date, default: null },
  connectedAt: { type: Date, default: Date.now },
  lastSyncedAt: { type: Date, default: null },
  status: { type: String, default: 'connected', enum: ['connected', 'error', 'disconnected'] }
}, { timestamps: true });
const googleBusinessLocationMappingSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  locationName: { type: String, required: true },
  locationDisplayName: { type: String, default: '' },
  accountName: { type: String, default: '' },
  serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre', required: true },
  serviceCentreName: { type: String, default: '' },
  mappedAt: { type: Date, default: Date.now },
  lastReviewSyncAt: { type: Date, default: null },
  lastSyncedReviewCount: { type: Number, default: 0 }
}, { timestamps: true });
googleBusinessLocationMappingSchema.index({ companyId: 1, locationName: 1 }, { unique: true });
const notificationSchema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }, portalRole: String, type: String, priority: { type: String, enum: ['normal', 'high'], default: 'normal' }, title: String, message: String, ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }, device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, reviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Review' }, action: { type: Object, default: null }, read: { type: Boolean, default: false } }, { timestamps: true });
const timelineSchema = new mongoose.Schema({ ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }, status: String, message: String, note: String, updatedBy: String, userRole: String, timestamp: { type: Date, default: Date.now } });
const callRecordSchema = new mongoose.Schema({ ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true }, agentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, agentName: String, ticketNumber: String, customerName: String, customerPhone: String, outcome: { type: String, enum: ['Issue Resolved Remotely', 'Customer Needs Further Assistance', 'Engineer Visit Required', 'Customer Unavailable', 'Call Back Required'], default: 'Customer Unavailable' }, notes: String, callStatus: { type: String, default: 'Call Attempted' } }, { timestamps: true });
const aiSupportSessionSchema = new mongoose.Schema({ ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, preparedRequest: { type: Object }, sessionId: { type: String, unique: true, required: true }, issueContext: { type: Object, default: {} }, messages: [{ role: { type: String, enum: ['user', 'assistant'], required: true }, content: { type: String, required: true }, timestamp: { type: Date, default: Date.now } }], troubleshootingSteps: [{ step: String, outcome: String, timestamp: { type: Date, default: Date.now } }], customerResponses: [{ response: String, timestamp: { type: Date, default: Date.now } }], result: { type: String, default: 'In Progress' }, status: { type: String, default: 'In Progress' }, escalationStatus: { type: String, enum: ['Not Escalated', 'Recommended Service Assistance', 'Resolved'], default: 'Not Escalated' }, providerAvailable: { type: Boolean, default: false }, providerStatus: String }, { timestamps: true });
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
export const Notification = mongoose.model('Notification', notificationSchema);
export const EscalationRule = mongoose.model('EscalationRule', escalationRuleSchema);
export const CallRecord = mongoose.model('CallRecord', callRecordSchema);
export const AITroubleshootingSession = mongoose.model('AITroubleshootingSession', aiSupportSessionSchema);
