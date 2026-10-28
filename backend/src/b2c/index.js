import { loadB2CConfig } from './b2cConfig.js';
import { b2cModels, ensureB2CIndexes } from './b2cModels.js';
import { B2C_ADMIN, DEFAULT_LEVELS } from './b2cDefaults.js';
import { createAttachmentStore } from './attachments.js';
import { createEmailConnectors } from './connectors/emailConnector.js';
import { createCrmConnector } from './connectors/crmConnector.js';
import { createB2CService } from './b2cService.js';
import { createB2CRouter, createB2CInternalRouter } from './b2cRoutes.js';
import { createB2CScheduler } from './b2cScheduler.js';

export { loadB2CConfig } from './b2cConfig.js';
export { createB2CService, B2CError } from './b2cService.js';
export { createB2CRouter, createB2CInternalRouter } from './b2cRoutes.js';

// Wires the B2C module into the shared API: shared User accounts and
// in-app notifications, B2C-only collections, connectors from the environment.
// Config is read when the module is created, after server.js has loaded .env.
export function createB2CModule({ User, Notification, EscalationRule, notifyUsers, auth, config = loadB2CConfig(), logger = console }) {
  const service = createB2CService({
    models: b2cModels,
    User,
    notifyUsers,
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
    internalRouter: createB2CInternalRouter({ service, config }),
    scheduler: createB2CScheduler({ service, minutes: config.pollMinutes, logger }),
    async initialise({ hashPassword }) {
      await ensureB2CIndexes();
      await service.getSettings();
      if (config.demoAccounts) await ensureB2CDemoAccounts({ User, hashPassword });
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
