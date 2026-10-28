// Tests for self-service sign-up: the field rules, the rate limiter, and the HTTP
// routes against a real MongoDB. Each run uses a new, uniquely named database that is
// dropped afterwards; set ACCOUNT_TEST_MONGODB_URI to point at a different server.
// The HTTP tests are skipped when MongoDB is not reachable. No email is ever sent.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { AccountRequest, Company, User } from '../models.js';
import { allowRoles, auth, restrictB2COnlyStaff } from '../middleware.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { createRateLimiter } from '../rateLimit.js';
import { isServiceEmailAllowed, normalizeAccountRequest, parseEmailDomains, passwordProblems } from './accountRequestRules.js';
import { REQUEST_RECEIVED_MESSAGE, SERVICE_ACCOUNT_CREATED_MESSAGE, createAccountRequestRouter } from './accountRequestRoutes.js';

const JWT_SECRET = 'account-request-test-secret';
process.env.JWT_SECRET = JWT_SECRET;
const valid = { accountType: 'corporate', name: '  Priya   Sharma ', email: ' Priya.Sharma@Example.COM ', phone: '+91 98765 43210', organization: 'Acme Industries', gstNumber: ' 27aapfu 0939f1zv ', password: 'Str0ngPass', confirmPassword: 'Str0ngPass' };

describe('sign-up field rules', () => {
  test('normalizes a valid request', () => {
    const { values, errors } = normalizeAccountRequest(valid);
    assert.deepEqual(errors, {});
    assert.deepEqual(values, { accountType: 'corporate', name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+91 98765 43210', organization: 'Acme Industries', gstNumber: '27AAPFU0939F1ZV' });
  });

  test('reports every invalid field', () => {
    const { errors } = normalizeAccountRequest({ name: 'A', email: 'not-an-email', phone: 'abc', organization: '', gstNumber: '27AAPFU0939F1Z', password: 'short' });
    assert.deepEqual(Object.keys(errors).sort(), ['email', 'gstNumber', 'name', 'organization', 'password', 'phone']);
  });

  test('requires a mobile number and GSTIN', () => {
    const { errors } = normalizeAccountRequest({ ...valid, phone: '', gstNumber: '' });
    assert.deepEqual(Object.keys(errors).sort(), ['gstNumber', 'phone']);
  });

  test('checks the password policy and confirmation', () => {
    assert.deepEqual(passwordProblems('Str0ngPass'), []);
    assert.ok(passwordProblems('alllowercase1').some(problem => /upper and lower/.test(problem)));
    assert.ok(passwordProblems('NoDigitsHere').some(problem => /number/.test(problem)));
    assert.ok(passwordProblems('Ab1').some(problem => /at least 8/.test(problem)));
    assert.equal(normalizeAccountRequest({ ...valid, confirmPassword: 'Different1' }).errors.confirmPassword, 'Passwords do not match.');
  });

  test('ignores fields sign-up does not accept', () => {
    const { values } = normalizeAccountRequest({ ...valid, role: 'iplanet_service', companyId: '0123456789abcdef01234567', status: 'approved' });
    assert.deepEqual(Object.keys(values).sort(), ['accountType', 'email', 'gstNumber', 'name', 'organization', 'phone']);
  });

  test('service sign-up domains match the whole email domain only', () => {
    const domains = parseEmailDomains(' iplanet.in, @IPlanet.co.in ,');
    assert.deepEqual(domains, ['iplanet.in', 'iplanet.co.in']);
    assert.equal(isServiceEmailAllowed('ravi@iplanet.in', domains), true);
    assert.equal(isServiceEmailAllowed('ravi@iplanet.co.in', domains), true);
    assert.equal(isServiceEmailAllowed('ravi@notiplanet.in', domains), false);
    assert.equal(isServiceEmailAllowed('ravi@iplanet.in.evil.com', domains), false);
    assert.equal(isServiceEmailAllowed('ravi@iplanet.in', parseEmailDomains('')), false);
  });

  test('rejects non-string values such as query operators', () => {
    const { errors } = normalizeAccountRequest({ ...valid, email: { $gt: '' }, password: { $ne: null } });
    assert.ok(errors.email);
    assert.ok(errors.password);
  });
});

describe('rate limiter', () => {
  test('allows up to the limit per key, then answers 429 until the window resets', () => {
    let time = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => time, key: req => req.ip });
    const call = ip => { let status = 200; let nextCalled = false; limiter({ ip }, { set() {}, status(code) { status = code; return { json() {} }; } }, () => { nextCalled = true; }); return nextCalled ? 200 : status; };
    assert.deepEqual([call('a'), call('a'), call('a'), call('b')], [200, 200, 429, 200]);
    time = 1000;
    assert.equal(call('a'), 200);
  });
});

const DB_NAME = `iplanet_account_requests_test_${Date.now()}_${process.pid}`;
let mongoAvailable = true;
try { await mongoose.connect(process.env.ACCOUNT_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017', { dbName: DB_NAME, serverSelectionTimeoutMS: 3000 }); } catch { mongoAvailable = false; }
const skip = mongoAvailable ? false : 'MongoDB is not reachable (set ACCOUNT_TEST_MONGODB_URI)';

describe('sign-up and approval routes', { skip }, () => {
  let server;
  let baseUrl;
  let company;
  let otherCompany;
  let service;
  let corporate;
  let b2cStaff;
  const notified = [];
  const token = user => jwt.sign({ id: user._id, name: user.name, email: user.email, role: user.role, companyId: user.companyId, serviceCentreId: user.serviceCentreId }, JWT_SECRET, { expiresIn: '1h' });
  const call = async (method, path, { body, as, ip } = {}) => {
    const response = await fetch(`${baseUrl}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token(as)}` } : {}), ...(ip ? { 'X-Forwarded-For': ip } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  // Each sign-up gets its own client address so the per-client limit only applies where a test wants it.
  let clientCount = 0;
  const register = (body, ip = `10.0.0.${++clientCount}`) => call('POST', '/auth/register', { body, ip });
  const login = async (email, password) => {
    const user = await User.findOne({ email }).select('+password');
    return Boolean(user && verifyPassword(password, user.password));
  };

  before(async () => {
    await Promise.all([AccountRequest.createIndexes(), User.createIndexes(), Company.createIndexes()]);
    [company, otherCompany] = await Company.create([{ name: 'Acme Industries', companyId: 'CO-ACME' }, { name: 'Other Corp', companyId: 'CO-OTHER' }]);
    [service, corporate, b2cStaff] = await User.create([
      { name: 'Service', email: 'service@test.local', password: hashPassword('Test@1234'), role: 'iplanet_service' },
      { name: 'Corporate', email: 'existing@acme.test', password: hashPassword('Test@1234'), role: 'corporate_admin', company: company.name, companyId: company._id },
      { name: 'B2C', email: 'b2c@test.local', password: hashPassword('Test@1234'), role: 'b2c_staff' },
    ]);
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api', restrictB2COnlyStaff);
    app.use('/api', createAccountRequestRouter({ models: { AccountRequest, User, Company }, auth, allowRoles, onRequested: async request => { notified.push(request.email); }, limits: { perClient: 3, perEmail: 3 }, serviceEmailDomains: ['iplanet.test'] }));
    app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise(resolve => server?.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('a valid sign-up creates a pending request, never a user, and stores only a password hash', async () => {
    const response = await register(valid);
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { status: 'pending', message: REQUEST_RECEIVED_MESSAGE });
    const request = await AccountRequest.findOne({ email: 'priya.sharma@example.com' }).select('+passwordHash').lean();
    assert.equal(request.status, 'pending');
    assert.match(request.passwordHash, /^scrypt\$/);
    assert.ok(!JSON.stringify(request).includes('Str0ngPass'), 'plaintext password is never stored');
    assert.equal(await User.exists({ email: 'priya.sharma@example.com' }), null);
    assert.equal(await login('priya.sharma@example.com', 'Str0ngPass'), false, 'a pending request cannot sign in');
    assert.deepEqual(notified, ['priya.sharma@example.com']);
  });

  test('invalid fields and mismatched passwords are rejected with field errors', async () => {
    const response = await register({ ...valid, email: 'bad', confirmPassword: 'Other1234' });
    assert.equal(response.status, 400);
    assert.ok(response.body.errors.email);
    const mismatch = await register({ ...valid, email: 'mismatch@example.com', confirmPassword: 'Other1234' });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.errors.confirmPassword, 'Passwords do not match.');
    assert.equal(await AccountRequest.exists({ email: 'mismatch@example.com' }), null);
  });

  test('duplicates get the same answer as new sign-ups and create nothing', async () => {
    const pendingAgain = await register({ ...valid, email: 'PRIYA.SHARMA@example.com' });
    const existingUser = await register({ ...valid, email: 'existing@acme.test' });
    assert.equal(pendingAgain.status, 202);
    assert.equal(existingUser.status, 202);
    assert.deepEqual(pendingAgain.body, existingUser.body);
    assert.equal(await AccountRequest.countDocuments({ email: 'priya.sharma@example.com' }), 1);
    assert.equal(await AccountRequest.exists({ email: 'existing@acme.test' }), null);
  });

  test('iPlanet Service sign-up is refused outside the allowed email domains', async () => {
    const response = await register({ ...valid, accountType: 'service', email: 'svc@example.com' });
    assert.equal(response.status, 403);
    assert.ok(response.body.errors.email);
    assert.equal(await AccountRequest.exists({ email: 'svc@example.com' }), null);
    assert.equal(await User.exists({ email: 'svc@example.com' }), null);
  });

  test('iPlanet Service sign-up on an allowed domain creates an active service user at once', async () => {
    const response = await register({ ...valid, accountType: 'service', email: 'Engineer@IPlanet.test', role: 'corporate_admin' });
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { status: 'active', message: SERVICE_ACCOUNT_CREATED_MESSAGE });
    const user = await User.findOne({ email: 'engineer@iplanet.test' }).lean();
    assert.equal(user.role, 'iplanet_service');
    assert.equal(user.gstNumber, '27AAPFU0939F1ZV');
    assert.equal(await login('engineer@iplanet.test', 'Str0ngPass'), true);
    assert.equal(await AccountRequest.exists({ email: 'engineer@iplanet.test' }), null);
    assert.equal((await register({ ...valid, accountType: 'service', email: 'engineer@iplanet.test' })).status, 409);
  });

  test('role, organization and status in the request body are ignored', async () => {
    const response = await register({ ...valid, email: 'sneaky@example.com', role: 'iplanet_service', companyId: String(otherCompany._id), status: 'approved', b2cRole: 'b2c_admin' });
    assert.equal(response.status, 202);
    const request = await AccountRequest.findOne({ email: 'sneaky@example.com' }).lean();
    assert.equal(request.status, 'pending');
    assert.equal(request.companyId, undefined);
    assert.equal(request.role, undefined);
    assert.equal(await User.exists({ email: 'sneaky@example.com' }), null);
  });

  test('sign-up is rate limited per client', async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) statuses.push((await register({ ...valid, email: `burst${attempt}@example.com` }, '10.9.9.9')).status);
    assert.deepEqual(statuses, [202, 202, 202, 429]);
  });

  test('only iPlanet Service users can list and review requests', async () => {
    assert.equal((await call('GET', '/iplanet/account-requests')).status, 401);
    assert.equal((await call('GET', '/iplanet/account-requests', { as: corporate })).status, 403);
    assert.equal((await call('GET', '/iplanet/account-requests', { as: b2cStaff })).status, 403);
    const request = await AccountRequest.findOne({ email: 'priya.sharma@example.com' });
    assert.equal((await call('POST', `/iplanet/account-requests/${request._id}/approve`, { as: corporate, body: { companyId: String(company._id) } })).status, 403);
    const list = await call('GET', '/iplanet/account-requests', { as: service });
    assert.equal(list.status, 200);
    assert.ok(list.body.some(item => item.email === 'priya.sharma@example.com'));
    assert.ok(list.body.every(item => !('passwordHash' in item)), 'password hashes are never returned');
  });

  test('approval needs an organization and creates a corporate admin for that organization only', async () => {
    const request = await AccountRequest.findOne({ email: 'priya.sharma@example.com' });
    assert.equal((await call('POST', `/iplanet/account-requests/${request._id}/approve`, { as: service, body: {} })).status, 400);
    const approved = await call('POST', `/iplanet/account-requests/${request._id}/approve`, { as: service, body: { companyId: String(company._id), role: 'iplanet_service' } });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'approved');
    const user = await User.findOne({ email: 'priya.sharma@example.com' }).lean();
    assert.equal(user.role, 'corporate_admin');
    assert.equal(String(user.companyId), String(company._id));
    assert.equal(user.b2cRole, null);
    assert.equal(await login('priya.sharma@example.com', 'Str0ngPass'), true, 'the approved account signs in with the password chosen at sign-up');
    const stored = await AccountRequest.findById(request._id).select('+passwordHash').lean();
    assert.equal(stored.passwordHash, undefined, 'the hash is removed from the request once copied');
    assert.equal((await call('POST', `/iplanet/account-requests/${request._id}/approve`, { as: service, body: { companyId: String(company._id) } })).status, 409);
  });

  test('a rejected request never becomes an account and the email can apply again', async () => {
    const request = await AccountRequest.findOne({ email: 'sneaky@example.com' });
    const rejected = await call('POST', `/iplanet/account-requests/${request._id}/reject`, { as: service });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, 'rejected');
    assert.equal((await call('POST', `/iplanet/account-requests/${request._id}/approve`, { as: service, body: { companyId: String(company._id) } })).status, 409);
    assert.equal(await User.exists({ email: 'sneaky@example.com' }), null);
    assert.equal((await register({ ...valid, email: 'sneaky@example.com' })).status, 202);
    assert.equal(await AccountRequest.countDocuments({ email: 'sneaky@example.com', status: 'pending' }), 1);
  });
});
