import dotenv from 'dotenv';
import express from 'express';
import compression from 'compression';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { User, Notification, EscalationRule, Device, Customer } from './models.js';
import { auth, restrictB2COnlyStaff } from './middleware.js';
import { hashPassword } from './passwords.js';
import { createCorsMiddleware } from './corsPolicy.js';
import { createB2CModule } from './b2c/index.js';

// Standalone B2C escalation server. It runs the B2C API and email scheduler in
// its own process, against the same MongoDB database as the main API. Users
// still sign in through the main API (/api/auth/login); this server accepts
// those tokens, so both servers must share JWT_SECRET.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
if (!process.env.JWT_SECRET) console.warn('[B2C server] JWT_SECRET is not set; tokens issued by the main API will be rejected.');

const app = express();
// Behind a proxy (e.g. Render), rate limits need the client address it forwards.
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1);
app.use(createCorsMiddleware());
app.use(compression());
app.use(express.json());
app.use('/api', restrictB2COnlyStaff);
app.get('/api/health', (_, res) => res.json({ success: true, message: 'B2C API is running' }));

// Same in-app notification records as the main API, so the portal bell shows B2C alerts.
async function notifyUsers({ users, company, ticket, device, type, title, message, serviceCentreId, reviewId, action, priority }) { if (!users.length) return; await Notification.insertMany(users.map(user => ({ user: user._id, company, serviceCentreId, ticket: ticket?._id, device: device?._id, reviewId, portalRole: user.role, type, priority, title, message, action, read: false }))); }
const b2c = createB2CModule({ User, Notification, EscalationRule, Device, Customer, notifyUsers, auth });
// Public registration links first: the staff router requires a sign-in for everything else.
app.use('/api/b2c/public', b2c.publicRouter);
app.use('/api/b2c', b2c.router);
app.use('/api/internal/b2c', b2c.internalRouter);
app.use('/api', (req, res) => res.status(404).json({ message: `API endpoint not found: ${req.method} ${req.originalUrl}` }));
app.use((error, req, res, _next) => {
  if (/not allowed by CORS/.test(error?.message || '')) return res.status(403).json({ message: 'Origin not allowed' });
  const status = Number(error?.status || error?.statusCode);
  if (status >= 400 && status < 500) return res.status(status).json({ message: error.expose === false ? 'Invalid request' : error.message || 'Invalid request' });
  console.error(`[B2C API ERROR] ${req.method} ${req.originalUrl}: ${error?.name || 'Error'} ${error?.message || ''}`);
  return res.status(500).json({ message: 'Something went wrong. Please try again.' });
});

const port = process.env.B2C_PORT || 5100;
mongoose.connect(process.env.MONGODB_URI).then(async () => { await b2c.initialise({ hashPassword }); b2c.scheduler.start(); app.listen(port, '0.0.0.0', () => console.log(`B2C API running at http://localhost:${port}`)); }).catch(error => { console.error('MongoDB connection failed:', error.message); process.exit(1); });
