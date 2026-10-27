import { loadB2CConfig, validateAckConfig, validateImapConfig } from './b2cConfig.js';
import { createSmtpAckSender } from './connectors/smtpAckSender.js';
import { b2cModels, ensureB2CIndexes } from './b2cModels.js';
import { B2C_ADMIN, DEFAULT_LEVELS } from './b2cDefaults.js';
import { createAttachmentStore } from './attachments.js';
import { createEmailConnectors } from './connectors/emailConnector.js';
import { createCrmConnector } from './connectors/crmConnector.js';
import { createB2CService } from './b2cService.js';
import { createB2CRouter, createB2CInternalRouter, createB2CPublicRouter } from './b2cRoutes.js';
import { createB2CScheduler } from './b2cScheduler.js';

export { loadB2CConfig } from './b2cConfig.js';
export { createB2CService, B2CError } from './b2cService.js';
export { createB2CRouter, createB2CInternalRouter, createB2CPublicRouter } from './b2cRoutes.js';

// Wires the B2C module into the shared API: shared User accounts and
// in-app notifications, B2C-only collections, connectors from the environment.
// Config is read when the module is created, after server.js has loaded .env.
export function createB2CModule({ User, Notification, EscalationRule, Device, Customer, notifyUsers, auth, config = loadB2CConfig(), logger = console }) {
  reportImapConfig(config.imap, logger);
  reportAckConfig(config.ack, logger);
  reportRegistrationConfig(config.registration, logger);
  const service = createB2CService({
    models: b2cModels,
    User,
    notifyUsers,
    // Escalations are matched to a registered customer, and routed to the region defined
    // on that customer's device.
    customerDirectory: createCustomerDirectory(Customer),
    deviceDirectory: createDeviceDirectory(Device),
    // Acknowledgements from the separate company address (B2C_ACK_*), not the inbox.
    ackSender: createSmtpAckSender(config.ack),
    // The B2B escalation rules (edited on the Escalation Matrix page) apply to B2C too.
    escalationRules: () => (EscalationRule ? EscalationRule.find({ isActive: true }).lean() : Promise.resolve([])),
    emailConnectors: createEmailConnectors({ config }),
    crmConnector: createCrmConnector({ config }),
    attachmentStore: createAttachmentStore({ dir: config.attachmentDir }),
    config,
    logger,
  });
  return {
    service,
    router: createB2CRouter({ service, auth, User, Notification, logger }),
    // Customer registration links: token only, no sign-in. Mount at /api/b2c/public before `router`.
    publicRouter: createB2CPublicRouter({ service, logger }),
    internalRouter: createB2CInternalRouter({ service, config }),
    scheduler: createB2CScheduler({ service, minutes: config.pollMinutes, logger }),
    async initialise({ hashPassword }) {
      await ensureB2CIndexes();
      await service.getSettings();
      if (config.demoAccounts) await ensureB2CDemoAccounts({ User, hashPassword });
    },
  };
}

// Startup check of the incoming-mail settings. Names missing variables only; never prints values.
export function reportImapConfig(imap = {}, logger = console) {
  const check = validateImapConfig(imap);
  if (check.configured) logger.info(`[B2C] IMAP incoming email available (${imap.host}:${imap.port}, ${imap.secure ? 'SSL/TLS' : 'STARTTLS'}, folder ${imap.mailbox}). Inboxes with provider "imap" are read from it.`);
  else logger.info(`[B2C] IMAP incoming email is not configured: ${check.missing.join(', ')} not set.`);
  return check;
}

// Startup check of the acknowledgement sender. Names missing variables only; never prints values.
export function reportAckConfig(ack = {}, logger = console) {
  if (!ack.enabled) { logger.info('[B2C] Acknowledgements from a company address are off (B2C_ACK_EMAIL_ENABLED is not true); the inbox connector sends them where it can.'); return { configured: false, missing: [] }; }
  const check = validateAckConfig(ack);
  if (check.configured) logger.info(`[B2C] Acknowledgements are sent from ${ack.fromEmail} via ${ack.smtp.host}:${ack.smtp.port} (${ack.smtp.secure ? 'SSL/TLS' : 'STARTTLS'}); unmatched senders: ${ack.unmatchedPolicy === 'sender' ? 'acknowledged' : 'not acknowledged'}.`);
  else logger.warn(`[B2C] Acknowledgements are enabled but not configured: ${check.missing.join(', ')} not set. They will fail until this is fixed.`);
  return check;
}

// Startup check of customer registration links. Never prints the token or credentials.
export function reportRegistrationConfig(registration = {}, logger = console) {
  if (!registration.enabled) return logger.info('[B2C] Customer registration links are off (B2C_REGISTRATION_ENABLED is not true).');
  if (!registration.portalUrl) return logger.warn('[B2C] Customer registration is enabled but B2C_REGISTRATION_PORTAL_URL is not a valid address (HTTPS in production); no registration email will be sent.');
  return logger.info(`[B2C] Customer registration links go to ${registration.portalUrl}/b2c/customer-registration/… and expire after ${registration.ttlHours} hours.`);
}

// Reads the portal's `devices` collection. The region of a device is its `location`.
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function createDeviceDirectory(Device) {
  if (!Device) return { findBySerial: async () => [], regions: async () => [] };
  return {
    // Exact serial number, ignoring case only. A few records are enough to detect duplicates.
    findBySerial: serial => Device.find({ serialNumber: { $regex: `^${escapeRegex(serial)}$`, $options: 'i' } }).select('_id serialNumber model location purchaseDate').limit(5).lean(),
    async regions() {
      const names = (await Device.distinct('location')).map(name => (typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '')).filter(Boolean);
      return [...new Map(names.map(name => [name.toLowerCase(), name])).values()].sort((a, b) => a.localeCompare(b));
    },
  };
}

// Reads the portal's `customers` collection: one record per purchase, each with the
// serial number of the device bought. Exact matches only; a name is never searched (it is
// only compared with the records these lookups return).
const CUSTOMER_FIELDS = '_id customerId name email mobileNumber deviceSerialNumber';
const CUSTOMER_LIMIT = 20;
export function createCustomerDirectory(Customer) {
  if (!Customer) return { findByEmail: async () => [], findByPhone: async () => [], findBySerial: async () => [], create: async () => { throw new Error('No customer collection is configured.'); } };
  const find = filter => Customer.find(filter).select(CUSTOMER_FIELDS).limit(CUSTOMER_LIMIT).lean();
  return {
    // Stored emails are lowercased by the schema.
    findByEmail: email => find({ email: String(email).toLowerCase() }),
    // `digits` comes from normalisePhone. A 10-digit Indian number is stored with or without +91 / 91 / 0.
    findByPhone: digits => find({ mobileNumber: { $regex: digits.length === 10 ? `^(\\+?91|0)?${digits}$` : `^\\+?${digits}$` } }),
    findBySerial: serial => find({ deviceSerialNumber: { $regex: `^${escapeRegex(serial)}$`, $options: 'i' } }),
    // A purchase record for a customer verified through registration (one record per device).
    // `session`: the transaction the registration is saved in, where the database has them.
    async create(record, { session } = {}) {
      const [created] = await Customer.create([{ name: record.name, email: record.email, mobileNumber: record.mobileNumber, deviceSerialNumber: record.deviceSerialNumber }], { session });
      return created.toObject();
    },
  };
}

// Local demo B2C-only staff for each B2C role (never created in production). Existing
// accounts are left unchanged.
export async function ensureB2CDemoAccounts({ User, hashPassword }) {
  const roles = [{ key: B2C_ADMIN, label: 'B2C Admin', email: 'b2c.admin@iplanet.local' }, ...DEFAULT_LEVELS.map(level => ({ key: level.key, label: level.label, email: `b2c.${level.key.replace(/_/g, '-')}@iplanet.local` }))];
  for (const role of roles) {
    await User.updateOne(
      { email: role.email },
      { $setOnInsert: { name: `${role.label} (Demo)`, email: role.email, password: hashPassword('Demo@123'), role: 'b2c_staff', company: 'B2C Escalations (Demo)', b2cRole: role.key, b2cRegions: [] } },
      { upsert: true },
    );
  }
}
