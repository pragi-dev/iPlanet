// HTTP-level tests for the Google Business routes. Google is mocked at the
// fetch layer and persistence uses an in-memory store, so no Google
// credentials or MongoDB are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createGoogleBusinessRouter } from './googleBusiness.js';
import { auth, allowRoles } from '../middleware.js';
import { createPubSubPushVerifier } from '../integrations/googleBusinessProfile/googleBusinessProfilePubSub.js';
import { createTransientReviewCache } from '../integrations/googleBusinessProfile/googleBusinessProfileSyncService.js';
import { configureGoogleBusinessRetries } from '../integrations/googleBusinessProfile/googleBusinessProfileProvider.js';
import { createGoogleBusinessOAuthState, encryptGoogleBusinessToken, decryptGoogleBusinessToken } from '../integrations/googleBusinessProfile/googleBusinessProfileAuth.js';

const JWT_SECRET = 'test-jwt-secret';
process.env.JWT_SECRET = JWT_SECRET;
const ENV = {
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GOOGLE_REDIRECT_URI: 'https://api.example.test/api/google-business/callback',
  GOOGLE_BUSINESS_SCOPE: 'https://www.googleapis.com/auth/business.manage', JWT_SECRET, GOOGLE_BUSINESS_RETURN_URL: 'https://portal.example.test/service/reviews/google',
  GOOGLE_PUBSUB_TOPIC: 'projects/test-project/topics/gbp', GOOGLE_PUBSUB_PUSH_AUDIENCE: 'https://api.example.test/api/google-business/pubsub', GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT: 'push@test-project.iam.gserviceaccount.com',
};
const SERVICE_USER = { _id: 'a'.repeat(24), role: 'iplanet_service' };
const CORPORATE_USER = { _id: 'b'.repeat(24), role: 'corporate_admin' };
const CENTRE = { _id: 'c'.repeat(24), name: 'Chennai Service Centre', status: 'Active' };
const CENTRE_2 = { _id: 'd'.repeat(24), name: 'Coimbatore Service Centre', status: 'Active' };
const tokenFor = user => jwt.sign({ id: user._id, role: user.role }, JWT_SECRET);
const silentLogger = { info() {}, warn() {}, error() {} };
const realFetch = globalThis.fetch;
configureGoogleBusinessRetries({ sleep: async ms => { sleeps.push(ms); } });
let sleeps = [];

// ---- In-memory store --------------------------------------------------------
function createFakeStore() {
  const state = { integration: null, mappings: [], receipts: [], notifications: [], users: [SERVICE_USER, CORPORATE_USER], centres: [CENTRE, CENTRE_2] };
  let nextId = 1;
  const id = () => String(nextId++).padStart(24, 'e');
  return {
    state,
    getIntegration: async () => state.integration && { ...state.integration },
    upsertIntegration: async update => { state.integration = { ...(state.integration || {}), ...update }; return { ...state.integration }; },
    updateIntegration: async update => { if (!state.integration) return null; state.integration = { ...state.integration, ...update }; return { ...state.integration }; },
    listMappings: async () => state.mappings.map(mapping => ({ ...mapping })),
    getMapping: async mappingId => state.mappings.find(mapping => mapping._id === String(mappingId)) || null,
    findMappingByLocation: async (accountName, locationName) => state.mappings.find(mapping => mapping.locationName === locationName && (!accountName || mapping.accountName === accountName)) || null,
    saveMapping: async mapping => {
      state.mappings = state.mappings.filter(item => item.locationName !== mapping.locationName || item.serviceCentreId === mapping.serviceCentreId);
      const existing = state.mappings.find(item => item.locationName === mapping.locationName);
      if (existing) { Object.assign(existing, mapping); return { ...existing }; }
      const created = { _id: id(), ...mapping, mappedAt: new Date() };
      state.mappings.push(created);
      return { ...created };
    },
    updateMapping: async (mappingId, update) => { const mapping = state.mappings.find(item => item._id === String(mappingId)); if (mapping) Object.assign(mapping, update); return mapping; },
    deleteMapping: async mappingId => { const before = state.mappings.length; state.mappings = state.mappings.filter(item => item._id !== String(mappingId)); return state.mappings.length < before; },
    getActiveServiceCentre: async centreId => state.centres.find(centre => centre._id === String(centreId) && centre.status === 'Active') || null,
    getUser: async userId => state.users.find(user => user._id === String(userId)) || null,
    serviceUsersForCentre: async () => state.users.filter(user => user.role === 'iplanet_service'),
    createNotifications: async docs => { state.notifications.push(...docs); return docs; },
    recordNotificationReceipt: async ({ messageId, eventKey, type, location }) => {
      const sameMessage = state.receipts.find(receipt => receipt.messageId === messageId);
      if (sameMessage) { if (sameMessage.status === 'failed') { sameMessage.status = 'processing'; return 'retry'; } return 'duplicate'; }
      if (eventKey && state.receipts.some(receipt => receipt.eventKey === eventKey)) return 'duplicate';
      state.receipts.push({ messageId, eventKey, type, location, status: 'processing' });
      return 'created';
    },
    updateNotificationReceipt: async (messageId, update) => { const receipt = state.receipts.find(item => item.messageId === messageId); if (receipt) Object.assign(receipt, update); },
  };
}

// ---- Google mock ----------------------------------------------------------------
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const googleError = (code, status, { reason, metadata } = {}) => json({ error: { code, status, message: 'redacted', details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, metadata: metadata || {} }] : [] } }, code);
const ACCOUNTS = { accounts: [{ name: 'accounts/111', accountName: 'iPlanet Retail', type: 'LOCATION_GROUP', role: 'OWNER', verificationState: 'VERIFIED' }] };
const LOCATIONS = { locations: [{ name: 'locations/222', title: 'iPlanet Chennai', storefrontAddress: { addressLines: ['1 Mount Road'], locality: 'Chennai' }, metadata: { mapsUri: 'https://maps.google.com/?cid=222' } }] };
const REVIEW = { name: 'accounts/111/locations/222/reviews/rev1', reviewId: 'rev1', reviewer: { displayName: 'Asha K', isAnonymous: false }, starRating: 'FOUR', comment: 'Quick battery replacement', createTime: '2026-10-01T10:00:00Z', updateTime: '2026-10-01T10:00:00Z' };

function mockGoogle(handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    calls.push({ url, method: init.method || 'GET', body: init.body, headers: init.headers || {} });
    const response = await handler(url, init, calls);
    if (!response) throw new Error(`Unexpected Google call: ${init.method || 'GET'} ${url}`);
    return response;
  };
  return calls;
}
const defaultGoogle = url => {
  if (url.pathname === '/v1/accounts') return json(ACCOUNTS);
  if (url.pathname === '/v1/accounts/111/locations') return json(LOCATIONS);
  if (url.pathname === '/v4/accounts/111/locations/222/reviews') return json({ reviews: [REVIEW], averageRating: 4.4, totalReviewCount: 87 });
  return null;
};

// ---- Pub/Sub signing ------------------------------------------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const pushToken = (claims = {}) => jwt.sign({ email: ENV.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT, email_verified: true, ...claims }, privateKey, { algorithm: 'RS256', keyid: 'test-kid', audience: ENV.GOOGLE_PUBSUB_PUSH_AUDIENCE, issuer: 'https://accounts.google.com', expiresIn: 300 });
const pushBody = (messageId, data) => ({ message: { messageId, data: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64'), publishTime: '2026-10-17T00:00:00Z' }, subscription: 'projects/test-project/subscriptions/gbp-push' });

// ---- Harness ----------------------------------------------------------------------
async function startApp({ store = createFakeStore(), reviewCache = createTransientReviewCache(), connected = true, expiresInMs = 3600_000 } = {}) {
  if (connected) {
    store.state.integration = {
      provider: 'google-business-profile', status: 'connected', accessToken: encryptGoogleBusinessToken('access-1', JWT_SECRET), refreshToken: encryptGoogleBusinessToken('refresh-1', JWT_SECRET),
      expiresAt: new Date(Date.now() + expiresInMs), grantedScope: ENV.GOOGLE_BUSINESS_SCOPE, accessState: 'unknown',
    };
  }
  const app = express();
  app.use(express.json());
  app.use('/api/google-business', createGoogleBusinessRouter({
    store, auth, allowRoles, env: ENV, reviewCache, logger: silentLogger,
    verifyPubSubPush: createPubSubPushVerifier({ config: { audience: ENV.GOOGLE_PUBSUB_PUSH_AUDIENCE, serviceAccountEmail: ENV.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT, topic: ENV.GOOGLE_PUBSUB_TOPIC }, loadJwks: async () => ({ keys: [JWK], ttlMs: 60_000 }) }),
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/google-business`;
  const call = async (path, { method = 'GET', user = SERVICE_USER, body, headers = {}, redirect = 'follow' } = {}) => {
    const response = await realFetch(`${base}${path}`, { method, redirect, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
  return { store, call, reviewCache, close: () => new Promise(resolve => server.close(resolve)) };
}

async function withApp(options, fn) {
  sleeps = [];
  const harness = await startApp(options);
  try { await fn(harness); } finally { await harness.close(); globalThis.fetch = realFetch; }
}

async function mapChennai(harness) {
  const result = await harness.call('/locations/map', { method: 'POST', body: { locationName: 'locations/222', serviceCentreId: CENTRE._id } });
  assert.equal(result.status, 201);
  return result.data.mapping;
}

// 1 & 2 ------------------------------------------------------------------------------
test('OAuth connected: status reports the connection and a new authorization is refused', async () => {
  await withApp({}, async ({ call }) => {
    mockGoogle(() => null);
    const status = await call('/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.connected, true);
    assert.equal(status.data.connection.scopeGranted, true);
    assert.equal(JSON.stringify(status.data).includes('access-1'), false, 'tokens never reach the browser');
    assert.equal((await call('/auth')).status, 409);
    const reconnect = await call('/auth?reconnect=true');
    assert.equal(reconnect.status, 200);
    assert.match(reconnect.data.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  });
});

test('OAuth disconnected: Google calls answer not_connected', async () => {
  await withApp({ connected: false }, async ({ call }) => {
    mockGoogle(() => null);
    assert.equal((await call('/status')).data.connected, false);
    const accounts = await call('/accounts');
    assert.equal(accounts.status, 409);
    assert.equal(accounts.data.error.category, 'not_connected');
  });
});

test('OAuth callback rejects forged state and accepts signed state once', async () => {
  await withApp({ connected: false }, async ({ call, store }) => {
    mockGoogle(url => url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token' ? json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: ENV.GOOGLE_BUSINESS_SCOPE, token_type: 'Bearer' }) : null);
    const forged = await call(`/callback?code=abc&state=${encodeURIComponent(JSON.stringify({ userId: SERVICE_USER._id }))}`, { user: null, redirect: 'manual' });
    assert.equal(forged.status, 303);
    assert.match(forged.headers.get('location'), /google=error&reason=invalid_state/);
    assert.equal(store.state.integration, null);

    const state = createGoogleBusinessOAuthState({ userId: SERVICE_USER._id, secret: JWT_SECRET });
    const ok = await call(`/callback?code=abc&state=${encodeURIComponent(state)}`, { user: null, redirect: 'manual' });
    assert.match(ok.headers.get('location'), /google=connected/);
    assert.equal(store.state.integration.status, 'connected');
    assert.notEqual(store.state.integration.accessToken, 'new-access', 'tokens are encrypted at rest');
    assert.equal(decryptGoogleBusinessToken(store.state.integration.refreshToken, JWT_SECRET), 'new-refresh');

    const replay = await call(`/callback?code=abc&state=${encodeURIComponent(state)}`, { user: null, redirect: 'manual' });
    assert.match(replay.headers.get('location'), /reason=invalid_state/);

    const corporateState = createGoogleBusinessOAuthState({ userId: CORPORATE_USER._id, secret: JWT_SECRET });
    const corporate = await call(`/callback?code=abc&state=${encodeURIComponent(corporateState)}`, { user: null, redirect: 'manual' });
    assert.match(corporate.headers.get('location'), /reason=not_authorized/);
  });
});

// 3 & 4 ----------------------------------------------------------------------------
test('Account discovery returns normalized accounts and records access as granted', async () => {
  await withApp({}, async ({ call, store }) => {
    mockGoogle(defaultGoogle);
    const result = await call('/accounts');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.accounts[0], { accountId: '111', accountName: 'accounts/111', accountDisplayName: 'iPlanet Retail', type: 'LOCATION_GROUP', role: 'OWNER', verificationState: 'VERIFIED' });
    assert.equal(store.state.integration.accessState, 'granted');
  });
});

test('No accessible Google accounts returns an empty list with an explanation', async () => {
  await withApp({}, async ({ call }) => {
    mockGoogle(url => url.pathname === '/v1/accounts' ? json({}) : null);
    const result = await call('/accounts');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.accounts, []);
    assert.match(result.data.message, /cannot access any Business Profile accounts/);
  });
});

// 5 & 6 ----------------------------------------------------------------------------
test('Zero quota is reported as access pending and is not retried', async () => {
  await withApp({}, async ({ call, store }) => {
    const calls = mockGoogle(() => googleError(429, 'RESOURCE_EXHAUSTED', { reason: 'RATE_LIMIT_EXCEEDED', metadata: { quota_limit_value: '0', quota_metric: 'mybusinessaccountmanagement.googleapis.com/default_requests', service: 'mybusinessaccountmanagement.googleapis.com' } }));
    const result = await call('/accounts');
    assert.equal(result.status, 503);
    assert.equal(result.data.error.category, 'access_pending');
    assert.match(result.data.message, /has not granted the API quota/);
    assert.equal(calls.length, 1, 'no retries for a zero-quota project');
    assert.equal(sleeps.length, 0);
    assert.equal(store.state.integration.accessState, 'pending');
    const status = await call('/status');
    assert.equal(status.data.access.state, 'pending');
    assert.equal(status.data.access.lastErrorCategory, 'access_pending');
  });
});

test('Transient 429 is retried with Retry-After and then succeeds', async () => {
  await withApp({}, async ({ call }) => {
    const rateLimited = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', metadata: { quota_limit_value: '300' } }] } };
    const calls = mockGoogle((url, _init, seen) => seen.length === 1 ? json(rateLimited, 429, { 'retry-after': '2' }) : defaultGoogle(url));
    const result = await call('/accounts');
    assert.equal(result.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2000], 'waited for Retry-After');
  });
});

test('Repeated transient 429s stop after the retry limit', async () => {
  await withApp({}, async ({ call }) => {
    const calls = mockGoogle(() => googleError(429, 'RESOURCE_EXHAUSTED', { reason: 'RATE_LIMIT_EXCEEDED', metadata: { quota_limit_value: '300' } }));
    const result = await call('/accounts');
    assert.equal(result.status, 429);
    assert.equal(result.data.error.category, 'rate_limited');
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000], 'exponential backoff');
  });
});

// 7 & 8 ------------------------------------------------------------------------------
test('Permission denied and disabled API are distinguished', async () => {
  await withApp({}, async ({ call }) => {
    mockGoogle(() => googleError(403, 'PERMISSION_DENIED'));
    const denied = await call('/accounts');
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error.category, 'permission_denied');
    mockGoogle(() => googleError(403, 'PERMISSION_DENIED', { reason: 'SERVICE_DISABLED', metadata: { service: 'mybusinessaccountmanagement.googleapis.com' } }));
    const disabled = await call('/accounts');
    assert.equal(disabled.data.error.category, 'api_disabled');
  });
});

test('Expired access token is refreshed before the call', async () => {
  await withApp({ expiresInMs: -1000 }, async ({ call, store }) => {
    const calls = mockGoogle(url => url.pathname === '/token' ? json({ access_token: 'access-2', expires_in: 3600, token_type: 'Bearer' }) : defaultGoogle(url));
    const result = await call('/accounts');
    assert.equal(result.status, 200);
    assert.equal(calls[0].url.pathname, '/token');
    assert.equal(calls[1].headers.Authorization, 'Bearer access-2');
    assert.equal(decryptGoogleBusinessToken(store.state.integration.accessToken, JWT_SECRET), 'access-2');
  });
});

test('A 401 from Google triggers one refresh and retry', async () => {
  await withApp({}, async ({ call }) => {
    let first = true;
    mockGoogle(url => {
      if (url.pathname === '/token') return json({ access_token: 'access-2', expires_in: 3600 });
      if (first) { first = false; return googleError(401, 'UNAUTHENTICATED'); }
      return defaultGoogle(url);
    });
    assert.equal((await call('/accounts')).status, 200);
  });
});

test('A revoked refresh token requires reconnecting', async () => {
  await withApp({ expiresInMs: -1000 }, async ({ call, store }) => {
    mockGoogle(url => url.pathname === '/token' ? json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) : null);
    const result = await call('/accounts');
    assert.equal(result.status, 401);
    assert.equal(result.data.error.category, 'reconnect_required');
    assert.equal(store.state.integration.status, 'reconnect_required');
    assert.equal((await call('/auth')).status, 200, 'reconnect flow is offered');
  });
});

// 9, 10, 11 ----------------------------------------------------------------------------
test('Review retrieval normalizes Google reviews without storing their content', async () => {
  await withApp({}, async harness => {
    const calls = mockGoogle(defaultGoogle);
    const mapping = await mapChennai(harness);
    const result = await harness.call('/reviews');
    assert.equal(result.status, 200);
    assert.equal(result.data.scope, 'retrieved');
    const location = result.data.locations[0];
    assert.equal(location.googleReportedTotal, 87);
    assert.deepEqual(location.reviews[0], {
      source: 'google', reviewId: 'rev1', reviewName: REVIEW.name, rating: 4, comment: 'Quick battery replacement',
      reviewer: { displayName: 'Asha K', isAnonymous: false, profilePhotoUrl: null }, createTime: REVIEW.createTime, updateTime: REVIEW.updateTime, reply: null,
      location: { mappingId: mapping.mappingId, locationName: 'locations/222', title: 'iPlanet Chennai', serviceCentreId: CENTRE._id, serviceCentreName: CENTRE.name, mapsUri: 'https://maps.google.com/?cid=222' },
    });
    assert.deepEqual(result.data.summary, { retrievedCount: 1, averageRating: 4, awaitingReply: 1 });
    const reviewCall = calls.find(call => call.url.pathname.endsWith('/reviews'));
    assert.equal(reviewCall.url.pathname, '/v4/accounts/111/locations/222/reviews', 'v4 path includes the account');
    assert.equal(reviewCall.url.searchParams.get('pageSize'), '50');
    assert.equal(harness.store.state.mappings[0].syncStatus, 'ok');
    assert.ok(harness.store.state.mappings[0].lastReviewSyncAt);
  });
});

test('Empty review list is returned as empty, never padded', async () => {
  await withApp({}, async harness => {
    mockGoogle(url => url.pathname.endsWith('/reviews') ? json({}) : defaultGoogle(url));
    await mapChennai(harness);
    const result = await harness.call('/reviews');
    assert.deepEqual(result.data.locations[0].reviews, []);
    assert.equal(result.data.locations[0].googleReportedTotal, null);
    assert.deepEqual(result.data.summary, { retrievedCount: 0, averageRating: null, awaitingReply: 0 });
  });
});

test('Pagination passes Google page tokens through per location', async () => {
  await withApp({}, async harness => {
    const calls = mockGoogle(url => {
      if (url.pathname.endsWith('/reviews')) return url.searchParams.get('pageToken') === 'page-2' ? json({ reviews: [{ ...REVIEW, name: 'accounts/111/locations/222/reviews/rev2', reviewId: 'rev2', starRating: 'TWO' }] }) : json({ reviews: [REVIEW], nextPageToken: 'page-2' });
      return defaultGoogle(url);
    });
    const mapping = await mapChennai(harness);
    const first = await harness.call('/reviews');
    assert.equal(first.data.locations[0].nextPageToken, 'page-2');
    const second = await harness.call(`/reviews?mappingId=${mapping.mappingId}&pageToken=page-2`);
    assert.equal(second.data.locations[0].reviews[0].reviewId, 'rev2');
    assert.equal(second.data.locations[0].nextPageToken, null);
    assert.equal(calls.filter(call => call.url.searchParams.get('pageToken') === 'page-2').length, 1);
    assert.equal((await harness.call('/reviews?pageToken=page-2')).status, 400);
  });
});

// 12 & 13 ---------------------------------------------------------------------------
test('Location mapping only accepts locations the connected account can access', async () => {
  await withApp({}, async harness => {
    mockGoogle(defaultGoogle);
    const mapping = await mapChennai(harness);
    assert.equal(mapping.accountName, 'accounts/111', 'account comes from Google, not the browser');
    const foreign = await harness.call('/locations/map', { method: 'POST', body: { locationName: 'locations/999', serviceCentreId: CENTRE._id } });
    assert.equal(foreign.status, 403);
    const badCentre = await harness.call('/locations/map', { method: 'POST', body: { locationName: 'locations/222', serviceCentreId: 'f'.repeat(24) } });
    assert.equal(badCentre.status, 404);
    const malformed = await harness.call('/locations/map', { method: 'POST', body: { locationName: '../../accounts', serviceCentreId: CENTRE._id } });
    assert.equal(malformed.status, 400);

    const moved = await harness.call('/locations/map', { method: 'POST', body: { locationName: 'locations/222', serviceCentreId: CENTRE_2._id } });
    assert.equal(moved.status, 201);
    assert.equal(harness.store.state.mappings.length, 1, 'remapping moves the location');
    assert.equal(harness.store.state.mappings[0].serviceCentreName, CENTRE_2.name);

    const locations = await harness.call('/locations');
    assert.equal(locations.data.locations[0].mapping.serviceCentreName, CENTRE_2.name);
    assert.equal((await harness.call(`/locations/map/${moved.data.mapping.mappingId}`, { method: 'DELETE' })).status, 200);
    assert.equal(harness.store.state.mappings.length, 0);
  });
});

test('Corporate Admin users cannot reach any Google Business management endpoint', async () => {
  await withApp({}, async ({ call }) => {
    const calls = mockGoogle(defaultGoogle);
    const endpoints = [['/status'], ['/auth'], ['/accounts'], ['/locations'], ['/reviews'], ['/mappings'], ['/check', 'POST'], ['/connection', 'DELETE'], ['/locations/map', 'POST'], ['/notifications', 'PUT'], [`/locations/${'e'.repeat(24)}/reviews/rev1/reply`, 'PUT']];
    for (const [path, method = 'GET'] of endpoints) {
      const result = await call(path, { method, user: CORPORATE_USER, body: method === 'GET' ? undefined : {} });
      assert.equal(result.status, 403, `${method} ${path}`);
    }
    assert.equal((await call('/status', { user: null })).status, 401);
    assert.equal(calls.length, 0);
  });
});

// 14 ------------------------------------------------------------------------------------
test('Review reply requires confirmation, uses PUT {comment}, and refreshes the review', async () => {
  await withApp({}, async harness => {
    const calls = mockGoogle((url, init) => {
      if (url.pathname.endsWith('/reviews/rev1/reply') && init.method === 'PUT') return json({ comment: JSON.parse(init.body).comment, updateTime: '2026-10-17T09:00:00Z' });
      if (url.pathname.endsWith('/reviews/rev1/reply') && init.method === 'DELETE') return new Response(null, { status: 200 });
      if (url.pathname.endsWith('/reviews/rev1')) return json({ ...REVIEW, reviewReply: { comment: 'Thank you, Asha!', updateTime: '2026-10-17T09:00:00Z' } });
      return defaultGoogle(url);
    });
    const mapping = await mapChennai(harness);
    const path = `/locations/${mapping.mappingId}/reviews/rev1/reply`;
    const unconfirmed = await harness.call(path, { method: 'PUT', body: { comment: 'Thank you, Asha!' } });
    assert.equal(unconfirmed.status, 400);
    assert.equal(calls.filter(call => call.method === 'PUT').length, 0, 'nothing is published without confirmation');

    const published = await harness.call(path, { method: 'PUT', body: { comment: 'Thank you, Asha!', confirmed: true } });
    assert.equal(published.status, 200);
    const put = calls.find(call => call.method === 'PUT');
    assert.equal(put.url.pathname, '/v4/accounts/111/locations/222/reviews/rev1/reply');
    assert.deepEqual(JSON.parse(put.body), { comment: 'Thank you, Asha!' });
    assert.equal(published.data.review.reply.comment, 'Thank you, Asha!');

    assert.equal((await harness.call(path, { method: 'PUT', body: { comment: 'x'.repeat(4097), confirmed: true } })).status, 400);
    const removed = await harness.call(path, { method: 'DELETE', body: { confirmed: true } });
    assert.equal(removed.status, 200);
    assert.ok(calls.some(call => call.method === 'DELETE'));
  });
});

test('Review reply failure from Google is reported, not hidden', async () => {
  await withApp({}, async harness => {
    mockGoogle((url, init) => init.method === 'PUT' ? googleError(403, 'PERMISSION_DENIED') : defaultGoogle(url));
    const mapping = await mapChennai(harness);
    const result = await harness.call(`/locations/${mapping.mappingId}/reviews/rev1/reply`, { method: 'PUT', body: { comment: 'Thanks', confirmed: true } });
    assert.equal(result.status, 403);
    assert.equal(result.data.error.category, 'permission_denied');
    assert.equal((await harness.call(`/locations/${mapping.mappingId}/reviews/bad id/reply`, { method: 'PUT', body: { comment: 'Thanks', confirmed: true } })).status, 400);
  });
});

// 15–18 ----------------------------------------------------------------------------------
const NEW_REVIEW_EVENT = { type: 'NEW_REVIEW', review: 'accounts/111/locations/222/reviews/rev9', location: 'accounts/111/locations/222' };

test('Pub/Sub: a valid authenticated message creates one operational notification', async () => {
  await withApp({}, async harness => {
    mockGoogle(defaultGoogle);
    await mapChennai(harness);
    const result = await harness.call('/pubsub', { user: null, headers: { Authorization: `Bearer ${pushToken()}` }, method: 'POST', body: pushBody('1001', NEW_REVIEW_EVENT) });
    assert.equal(result.status, 204);
    assert.equal(harness.store.state.notifications.length, 1);
    const notification = harness.store.state.notifications[0];
    assert.equal(notification.type, 'GOOGLE_REVIEW_ACTIVITY');
    assert.equal(notification.message, 'New Google review activity detected for Chennai Service Centre.');
    assert.match(notification.action.route, /^\/service\/reviews\/google\?location=/);
    assert.equal(harness.store.state.mappings[0].syncStatus, 'pending');
    assert.equal(harness.store.state.receipts[0].status, 'processed');
  });
});

test('Pub/Sub: unauthenticated or mis-addressed pushes are rejected', async () => {
  await withApp({}, async harness => {
    mockGoogle(defaultGoogle);
    const body = pushBody('1002', NEW_REVIEW_EVENT);
    assert.equal((await harness.call('/pubsub', { user: null, method: 'POST', body })).status, 401);
    assert.equal((await harness.call('/pubsub', { user: null, method: 'POST', body, headers: { Authorization: `Bearer ${pushToken({ email: 'attacker@example.com' })}` } })).status, 401);
    assert.equal((await harness.call('/pubsub', { user: null, method: 'POST', body, headers: { Authorization: `Bearer ${tokenFor(SERVICE_USER)}` } })).status, 401, 'portal JWTs are not accepted');
    const wrongAudience = jwt.sign({ email: ENV.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT, email_verified: true }, privateKey, { algorithm: 'RS256', keyid: 'test-kid', audience: 'https://other.example', issuer: 'https://accounts.google.com', expiresIn: 300 });
    assert.equal((await harness.call('/pubsub', { user: null, method: 'POST', body, headers: { Authorization: `Bearer ${wrongAudience}` } })).status, 401);
    assert.equal(harness.store.state.receipts.length, 0);
  });
});

test('Pub/Sub: malformed messages are acknowledged without side effects', async () => {
  await withApp({}, async harness => {
    mockGoogle(defaultGoogle);
    await mapChennai(harness);
    const auth = { Authorization: `Bearer ${pushToken()}` };
    for (const body of [{}, { message: { messageId: '2001' } }, pushBody('2002', 'not json'), pushBody('2003', { type: 'NEW_REVIEW' }), pushBody('2004', { type: 'NEW_REVIEW', location: 'locations/../../x' })]) {
      assert.equal((await harness.call('/pubsub', { user: null, method: 'POST', body, headers: auth })).status, 204);
    }
    assert.equal(harness.store.state.notifications.length, 0);
    assert.ok(harness.store.state.receipts.every(receipt => receipt.status === 'ignored'));
  });
});

test('Pub/Sub: duplicate delivery of the same message is processed once', async () => {
  await withApp({}, async harness => {
    mockGoogle(defaultGoogle);
    await mapChennai(harness);
    const request = { user: null, method: 'POST', body: pushBody('3001', { ...NEW_REVIEW_EVENT, type: 'UPDATED_REVIEW' }), headers: { Authorization: `Bearer ${pushToken()}` } };
    assert.equal((await harness.call('/pubsub', request)).status, 204);
    assert.equal((await harness.call('/pubsub', request)).status, 204);
    assert.equal(harness.store.state.notifications.length, 1);
  });
});

test('Notification deduplication: the same new review under a new message ID notifies once', async () => {
  await withApp({}, async harness => {
    mockGoogle(defaultGoogle);
    await mapChennai(harness);
    const headers = { Authorization: `Bearer ${pushToken()}` };
    await harness.call('/pubsub', { user: null, method: 'POST', body: pushBody('4001', NEW_REVIEW_EVENT), headers });
    await harness.call('/pubsub', { user: null, method: 'POST', body: pushBody('4002', NEW_REVIEW_EVENT), headers });
    await harness.call('/pubsub', { user: null, method: 'POST', body: pushBody('4003', { ...NEW_REVIEW_EVENT, review: 'accounts/111/locations/222/reviews/rev10' }), headers });
    assert.equal(harness.store.state.notifications.length, 2);
  });
});

test('Pub/Sub: unmapped locations are acknowledged without alerts', async () => {
  await withApp({}, async harness => {
    mockGoogle(defaultGoogle);
    const result = await harness.call('/pubsub', { user: null, method: 'POST', body: pushBody('5001', NEW_REVIEW_EVENT), headers: { Authorization: `Bearer ${pushToken()}` } });
    assert.equal(result.status, 204);
    assert.equal(harness.store.state.notifications.length, 0);
    assert.equal(harness.store.state.receipts[0].outcome, 'unmapped_location');
  });
});

// 19 --------------------------------------------------------------------------------------
test('Retention: review content stays out of persistent storage and expires from memory', async () => {
  let clock = Date.now();
  const reviewCache = createTransientReviewCache({ ttlMs: 1000, now: () => clock });
  await withApp({ reviewCache }, async harness => {
    const calls = mockGoogle(defaultGoogle);
    await mapChennai(harness);
    await harness.call('/reviews');
    await harness.call('/pubsub', { user: null, method: 'POST', body: pushBody('6001', NEW_REVIEW_EVENT), headers: { Authorization: `Bearer ${pushToken()}` } });
    const persisted = JSON.stringify(harness.store.state);
    for (const fragment of ['Quick battery replacement', 'Asha K', 'FOUR']) assert.equal(persisted.includes(fragment), false, `"${fragment}" must not be persisted`);

    const reviewCalls = () => calls.filter(call => call.url.pathname.endsWith('/reviews')).length;
    const before = reviewCalls();
    await harness.call('/reviews');
    assert.equal(reviewCalls(), before + 1, 'Pub/Sub activity invalidated the cache');
    await harness.call('/reviews');
    assert.equal(reviewCalls(), before + 1, 'served from the short-lived cache');
    clock += 1001;
    assert.equal(reviewCache.size, 0, 'cached review content expires');
    await harness.call('/reviews');
    assert.equal(reviewCalls(), before + 2);
  });
});

test('Retention: Pub/Sub receipts carry a TTL index and no review content', async () => {
  const { GoogleBusinessNotificationReceipt, GOOGLE_NOTIFICATION_RECEIPT_TTL_SECONDS } = await import('../models.js');
  const ttlIndex = GoogleBusinessNotificationReceipt.schema.indexes().find(([fields]) => fields.receivedAt === 1);
  assert.equal(ttlIndex[1].expireAfterSeconds, GOOGLE_NOTIFICATION_RECEIPT_TTL_SECONDS);
  assert.deepEqual(Object.keys(GoogleBusinessNotificationReceipt.schema.paths).filter(path => /comment|reviewer|rating/i.test(path)), []);
});

// 20 --------------------------------------------------------------------------------------
test('Disconnecting revokes the token at Google and clears local credentials', async () => {
  await withApp({}, async harness => {
    const calls = mockGoogle(url => url.pathname === '/revoke' ? new Response('', { status: 200 }) : defaultGoogle(url));
    await mapChennai(harness);
    await harness.call('/reviews');
    const result = await harness.call('/connection', { method: 'DELETE' });
    assert.equal(result.status, 200);
    assert.equal(result.data.revoked, true);
    const revoke = calls.find(call => call.url.pathname === '/revoke');
    assert.equal(new URLSearchParams(revoke.body).get('token'), 'refresh-1');
    assert.equal(harness.store.state.integration.accessToken, null);
    assert.equal(harness.store.state.integration.refreshToken, null);
    assert.equal(harness.store.state.integration.status, 'disconnected');
    assert.equal(harness.reviewCache.size, 0);
    assert.equal((await harness.call('/reviews')).status, 409);
  });
});
