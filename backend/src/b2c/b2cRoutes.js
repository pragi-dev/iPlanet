import express from 'express';
import { B2C_ADMIN, B2C_ROLES } from './b2cDefaults.js';
import { safeErrorMessage } from './redact.js';

// /api/b2c — B2C escalation management. Every route requires a B2C-only
// ('b2c_staff') or iPlanet Service login whose user record holds a B2C role.
// The role is read from the database on each request, so revoking it takes
// effect immediately rather than when the JWT expires.
const PORTAL_ROLES = ['b2c_staff', 'iplanet_service'];
const NOTIFICATION_TYPE = 'B2C_ESCALATION';

export function createB2CRouter({ service, auth, User, Notification, logger = console }) {
  const router = express.Router();

  async function loadB2CUser(req, res, next) {
    try {
      if (!PORTAL_ROLES.includes(req.user?.role)) return res.status(403).json({ message: 'This account does not have access to B2C escalations.' });
      const user = await User.findById(req.user.id).select('name email role b2cRole b2cRegions').lean();
      if (!user || !PORTAL_ROLES.includes(user.role) || !B2C_ROLES.includes(user.b2cRole)) return res.status(403).json({ message: 'This account does not have access to B2C escalations.' });
      req.b2cUser = { id: String(user._id), name: user.name, email: user.email, role: user.role, b2cRole: user.b2cRole, b2cRegions: user.b2cRegions || [] };
      next();
    } catch (error) { next(error); }
  }
  const adminOnly = (req, res, next) => (req.b2cUser.b2cRole === B2C_ADMIN ? next() : res.status(403).json({ message: 'Only a B2C administrator can do this.' }));
  const handle = fn => async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result);
    } catch (error) {
      const status = Number(error?.status);
      if (status >= 400 && status < 500) return res.status(status).json({ message: error.message });
      logger.error(`[B2C] ${req.method} ${req.baseUrl}${req.route?.path || ''} failed: ${safeErrorMessage(error)}`);
      res.status(500).json({ message: 'Something went wrong. Please try again.' });
    }
  };

  router.use(auth, loadB2CUser);

  router.get('/me', handle(req => ({ ...req.b2cUser, isAdmin: req.b2cUser.b2cRole === B2C_ADMIN })));
  router.get('/dashboard', handle(req => service.dashboard(req.b2cUser)));
  router.get('/staff', handle(() => service.staffForUser()));
  router.get('/tickets', handle(req => service.listTickets(req.query, req.b2cUser)));
  router.get('/tickets/:id', handle(req => service.getTicketDetail(req.params.id, req.b2cUser)));
  router.post('/tickets/:id/actions/:action', handle(req => service.performAction(req.params.id, req.params.action, req.body || {}, req.b2cUser)));
  router.get('/tickets/:id/attachments/:key', handle(async (req, res) => {
    const attachment = await service.attachmentFor(req.params.id, req.params.key, req.b2cUser);
    // Always a download, never rendered inline by the browser.
    res.set({
      'Content-Type': attachment.contentType,
      'Content-Length': String(attachment.content.length),
      'Content-Disposition': `attachment; filename="${attachment.filename.replace(/[^\w.() -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    res.end(attachment.content);
  }));
  router.get('/reports', handle(req => service.reports(req.query, req.b2cUser)));

  // B2C notifications for the signed-in user (the B2B notification centre
  // also shows them to iPlanet Service accounts).
  const mine = req => ({ user: req.b2cUser.id, type: NOTIFICATION_TYPE });
  router.get('/notifications', handle(req => Notification.find(mine(req)).sort({ createdAt: -1 }).limit(100).lean()));
  router.get('/notifications/unread-count', handle(async req => ({ count: await Notification.countDocuments({ ...mine(req), read: false }) })));
  router.patch('/notifications/read-all', handle(async req => { await Notification.updateMany({ ...mine(req), read: false }, { read: true }); return { ok: true }; }));
  router.patch('/notifications/:id/read', handle(async req => {
    const notification = /^[a-f0-9]{24}$/i.test(req.params.id) ? await Notification.findOneAndUpdate({ _id: req.params.id, ...mine(req) }, { read: true }, { new: true }).lean() : null;
    if (!notification) throw Object.assign(new Error('Notification not found'), { status: 404 });
    return notification;
  }));

  router.get('/settings', adminOnly, handle(() => service.getSettings()));
  router.put('/settings', adminOnly, handle(req => service.updateSettings(req.body || {}, req.b2cUser)));
  router.get('/integrations/health', adminOnly, handle(() => service.health()));
  router.post('/integrations/run', adminOnly, handle(() => service.runCycle('manual')));
  router.get('/inbound', adminOnly, handle(req => service.listInbound(req.query)));
  router.post('/inbound/:id/retry', adminOnly, handle(req => service.retryInbound(req.params.id, req.b2cUser)));
  router.get('/outbound', adminOnly, handle(req => service.listOutbound(req.query)));
  router.post('/outbound/:id/retry', adminOnly, handle(req => service.retryOutbound(req.params.id)));

  // TEST ADAPTER ONLY — returns 404 when the test adapter is disabled.
  router.post('/test-adapter/inbound', adminOnly, handle(req => service.injectTestEmail(req.body || {}, req.b2cUser)));
  router.get('/test-adapter/outbox', adminOnly, handle(() => service.testOutbox()));

  return router;
}

// External cron trigger. Disabled unless B2C_CRON_SECRET is set.
export function createB2CInternalRouter({ service, config }) {
  const router = express.Router();
  router.post('/run', async (req, res) => {
    if (!config.cronSecret) return res.status(404).json({ message: 'Not found' });
    if (req.get('authorization') !== `Bearer ${config.cronSecret}`) return res.status(401).json({ message: 'Unauthorized' });
    try { res.json(await service.runCycle('cron')); } catch { res.status(500).json({ message: 'B2C processing failed.' }); }
  });
  return router;
}
