import express from 'express';
import mongoose from 'mongoose';
import { hashPassword } from '../passwords.js';
import { createRateLimiter } from '../rateLimit.js';
import { SELF_SERVICE_ACCOUNT_TYPES, isServiceEmailAllowed, normalizeAccountRequest } from './accountRequestRules.js';

// The same answer is given whether or not the email already has an account or a
// pending request, so sign-up can't be used to find out who uses the portal.
export const REQUEST_RECEIVED_MESSAGE = 'Your request has been received. An iPlanet administrator will review it and link your account to your organization. You can sign in once it is approved.';
export const SERVICE_ACCOUNT_CREATED_MESSAGE = 'Your iPlanet Service account is ready. You can sign in now.';
export const SERVICE_DOMAIN_MESSAGE = 'iPlanet Service accounts can only be created with an iPlanet work email address. Ask your service manager if you need access.';
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const publicRequest = request => ({ id: request._id, name: request.name, email: request.email, phone: request.phone || '', organization: request.organization, gstNumber: request.gstNumber || '', status: request.status, createdAt: request.createdAt, reviewedAt: request.reviewedAt || null, companyId: request.companyId || null });

// Self-service sign-up, mounted at /api.
//   POST /auth/register                            public; corporate: creates a pending request only;
//                                                  service: creates an active iplanet_service user when
//                                                  the email is on one of serviceEmailDomains
//   GET  /iplanet/account-requests                  iPlanet Service; ?status=pending|approved|rejected
//   POST /iplanet/account-requests/:id/approve      iPlanet Service; { companyId } creates the user
//   POST /iplanet/account-requests/:id/reject       iPlanet Service
// Approval always creates a corporate_admin for the organization the reviewer picks;
// the role and organization never come from the requester.
export function createAccountRequestRouter({ models, auth, allowRoles, onRequested = async () => {}, now = () => Date.now(), limits = {}, serviceEmailDomains = [] }) {
  const { AccountRequest, User, Company } = models;
  const router = express.Router();
  const serviceAuth = [auth, allowRoles('iplanet_service')];
  const perClient = createRateLimiter({ windowMs: 15 * 60 * 1000, max: limits.perClient ?? 10, now, message: 'Too many sign-up attempts. Please try again later.' });
  const perEmail = createRateLimiter({ windowMs: 60 * 60 * 1000, max: limits.perEmail ?? 3, now, key: req => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''), message: 'Too many sign-up attempts. Please try again later.' });

  router.post('/auth/register', perClient, perEmail, async (req, res) => {
    const { values, password, errors } = normalizeAccountRequest(req.body);
    if (!SELF_SERVICE_ACCOUNT_TYPES.includes(values.accountType)) return res.status(403).json({ message: 'This account type cannot be requested online.' });
    if (Object.keys(errors).length) return res.status(400).json({ message: 'Please correct the highlighted fields.', errors });
    const sameEmail = { email: new RegExp(`^${escapeRegex(values.email)}$`, 'i') };
    if (values.accountType === 'service') {
      if (!isServiceEmailAllowed(values.email, serviceEmailDomains)) return res.status(403).json({ message: SERVICE_DOMAIN_MESSAGE, errors: { email: SERVICE_DOMAIN_MESSAGE } });
      const taken = { message: 'An account with this email already exists. Sign in instead.', errors: { email: 'An account with this email already exists.' } };
      if (await User.exists(sameEmail)) return res.status(409).json(taken);
      try {
        await User.create({ name: values.name, email: values.email, password: hashPassword(password), role: 'iplanet_service', phone: values.phone, company: values.organization, gstNumber: values.gstNumber });
      } catch (error) {
        if (error?.code === 11000) return res.status(409).json(taken);
        throw error;
      }
      return res.status(201).json({ status: 'active', message: SERVICE_ACCOUNT_CREATED_MESSAGE });
    }
    const [existingUser, pending] = await Promise.all([User.exists(sameEmail), AccountRequest.exists({ ...sameEmail, status: 'pending' })]);
    if (!existingUser && !pending) {
      try {
        const request = await AccountRequest.create({ name: values.name, email: values.email, phone: values.phone, organization: values.organization, gstNumber: values.gstNumber, passwordHash: hashPassword(password) });
        await onRequested(request).catch(error => console.warn(`[Account requests] Could not notify reviewers: ${error.message}`));
      } catch (error) {
        // A simultaneous request for the same email already holds the pending slot.
        if (error?.code !== 11000) throw error;
      }
    }
    res.status(202).json({ status: 'pending', message: REQUEST_RECEIVED_MESSAGE });
  });

  router.get('/iplanet/account-requests', ...serviceAuth, async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const requests = await AccountRequest.find({ status }).sort({ createdAt: status === 'pending' ? 1 : -1 }).limit(200).lean();
    res.json(requests.map(publicRequest));
  });

  router.post('/iplanet/account-requests/:id/approve', ...serviceAuth, async (req, res) => {
    const { companyId } = req.body || {};
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Account request not found' });
    if (typeof companyId !== 'string' || !mongoose.isValidObjectId(companyId)) return res.status(400).json({ message: 'Choose the organization this account belongs to.' });
    const [request, company] = await Promise.all([AccountRequest.findById(req.params.id).select('+passwordHash'), Company.findById(companyId)]);
    if (!request) return res.status(404).json({ message: 'Account request not found' });
    if (request.status !== 'pending') return res.status(409).json({ message: `This request has already been ${request.status}.` });
    if (!company) return res.status(400).json({ message: 'Choose the organization this account belongs to.' });
    if (await User.exists({ email: new RegExp(`^${escapeRegex(request.email)}$`, 'i') })) return res.status(409).json({ message: 'An account with this email already exists. Reject this request instead.' });
    let user;
    try {
      user = await User.create({ name: request.name, email: request.email, password: request.passwordHash, role: 'corporate_admin', company: company.name, companyId: company._id, phone: request.phone });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ message: 'An account with this email already exists. Reject this request instead.' });
      throw error;
    }
    const approved = await AccountRequest.findOneAndUpdate({ _id: request._id, status: 'pending' }, { $set: { status: 'approved', reviewedBy: req.user.id, reviewedAt: new Date(now()), companyId: company._id, userId: user._id }, $unset: { passwordHash: 1 } }, { new: true }).lean();
    res.json(publicRequest(approved || request));
  });

  router.post('/iplanet/account-requests/:id/reject', ...serviceAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Account request not found' });
    const rejected = await AccountRequest.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'rejected', reviewedBy: req.user.id, reviewedAt: new Date(now()) }, $unset: { passwordHash: 1 } }, { new: true }).lean();
    if (rejected) return res.json(publicRequest(rejected));
    const existing = await AccountRequest.findById(req.params.id).lean();
    return existing ? res.status(409).json({ message: `This request has already been ${existing.status}.` }) : res.status(404).json({ message: 'Account request not found' });
  });

  return router;
}
