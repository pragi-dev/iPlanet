import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({ name: String, email: { type: String, unique: true }, password: String, role: { type: String, default: 'corporate_admin' }, company: String, companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }, phone: String });
const companySchema = new mongoose.Schema({ name: { type: String, unique: true }, companyId: { type: String, unique: true }, contactName: String, contactEmail: String, phone: String, location: String });
const serviceCentreSchema = new mongoose.Schema({ name: { type: String, unique: true }, location: { type: String, required: true }, address: String, city: String, state: String, contactNumber: String, email: String, status: { type: String, default: 'Active' }, googleBusinessProfile: { accountId: String, locationId: String, locationName: String, placeId: String, connected: { type: Boolean, default: false } } }, { timestamps: true });
const deviceSchema = new mongoose.Schema({ assetId: String, serialNumber: { type: String, unique: true }, deviceType: String, model: String, companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, selectedEntityId: { type: mongoose.Schema.Types.ObjectId }, selectedEntityType: { type: String, enum: ['corporate', 'service_centre'] }, employeeName: String, employeeId: String, department: String, location: String, purchaseDate: Date, warrantyStatus: String, warrantyExpiry: Date, amcStatus: String, amcExpiry: Date, deviceStatus: String, deviceAllocationStatus: { type: String, enum: ['Unassigned', 'Assigned'], default: 'Unassigned' }, lastServiceDate: Date });
const deviceMasterSchema = new mongoose.Schema({ serialNumber: { type: String, unique: true }, deviceType: String, model: String, assetId: String, purchaseDate: Date, warrantyStatus: String, warrantyExpiry: Date, amcStatus: String, amcExpiry: Date });
const engineerSchema = new mongoose.Schema({ name: String, employeeId: { type: String, unique: true }, email: { type: String, unique: true }, phone: String, location: String, status: { type: String, default: 'Available' }, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } });
const ticketSchema = new mongoose.Schema({ ticketId: { type: String, unique: true }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }, deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, category: String, issueType: String, description: String, images: [String], originalImages: [String], annotatedImages: [String], location: String, preferredServiceDate: Date, priority: String, status: { type: String, default: 'Open' }, assignedEngineer: String, assignedEngineerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Engineer' }, assignedAt: Date, expectedTAT: String, responseTarget: String, resolutionTarget: String, slaTargetAt: Date, slaStatus: { type: String, enum: ['Healthy', 'At Risk', 'Escalated', 'SLA Breached', 'Resolved'], default: 'Healthy' }, escalationLevel: { type: Number, default: 0 }, escalationStatus: { type: String, enum: ['Not Escalated', 'At Risk', 'Escalated', 'SLA Breached', 'Resolved'], default: 'Not Escalated' }, escalationReason: String, escalatedAt: Date }, { timestamps: true });
const escalationRuleSchema = new mongoose.Schema({ name: { type: String, required: true }, level: { type: Number, min: 1, max: 3, required: true }, trigger: { type: String, required: true }, priority: { type: String, default: 'All' }, slaThreshold: { type: Number, min: 0, max: 100, required: true }, action: { type: String, required: true }, isActive: { type: Boolean, default: true } }, { timestamps: true });
const googleReviewSchema = new mongoose.Schema({
  googleReviewId: { type: String, required: true, unique: true, index: true },
  googleLocationId: { type: String, index: true },
  googleAccountId: { type: String, index: true },
  serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre', index: true },
  serviceCentreName: String,
  reviewerName: String,
  rating: { type: Number, default: 0 },
  comment: String,
  reviewCreatedAt: { type: Date, index: true },
  reviewUpdatedAt: Date,
  sentiment: { type: String, enum: ['positive', 'neutral', 'negative'], default: 'neutral', index: true },
  sentimentScore: Number,
  aiSummary: String,
  keyIssue: String,
  suggestedResponse: String,
  recommendedAction: String,
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'low', index: true },
  status: { type: String, enum: ['Open', 'Acknowledged', 'Resolved'], default: 'Open', index: true },
  notificationCreated: { type: Boolean, default: false },
  acknowledgedAt: Date,
  resolvedAt: Date,
  googleReplyStatus: { type: String, default: 'not_attempted' },
  googleReply: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });
const notificationSchema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, serviceCentreId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCentre' }, portalRole: String, type: String, title: String, message: String, ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }, device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, reviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoogleReview' }, read: { type: Boolean, default: false } }, { timestamps: true });
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
export const GoogleReview = mongoose.model('GoogleReview', googleReviewSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const EscalationRule = mongoose.model('EscalationRule', escalationRuleSchema);
export const CallRecord = mongoose.model('CallRecord', callRecordSchema);
export const AITroubleshootingSession = mongoose.model('AITroubleshootingSession', aiSupportSessionSchema);
