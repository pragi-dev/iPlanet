import express from 'express';
import {
  buildGoogleBusinessAuthUrl, createGoogleBusinessOAuthState, verifyGoogleBusinessOAuthState, decryptGoogleBusinessToken, encryptGoogleBusinessToken,
  exchangeGoogleBusinessCodeForTokens, refreshGoogleBusinessTokens, getGoogleBusinessOauthConfig, validateGoogleBusinessOauthConfig,
  grantedScopeIncludesBusinessManage, revokeGoogleBusinessToken,
} from '../integrations/googleBusinessProfile/googleBusinessProfileAuth.js';
import {
  listGoogleBusinessAccounts, normalizeGoogleBusinessAccount, discoverGoogleBusinessLocations, getGoogleBusinessReviews, getGoogleBusinessReview,
  updateGoogleBusinessReviewReply, deleteGoogleBusinessReviewReply, getGoogleBusinessNotificationSetting, updateGoogleBusinessNotificationSetting,
  googleReviewsLocationPath, isGoogleAccountName, isGoogleLocationName, isGoogleReviewId, GOOGLE_REVIEWS_MAX_PAGE_SIZE, GOOGLE_REVIEW_NOTIFICATION_TYPES,
} from '../integrations/googleBusinessProfile/googleBusinessProfileProvider.js';
import { normalizeGoogleBusinessReview, createTransientReviewCache, summarizeRetrievedReviews, GOOGLE_REVIEW_CACHE_TTL_MS } from '../integrations/googleBusinessProfile/googleBusinessProfileSyncService.js';
import { GoogleBusinessApiError, GOOGLE_ERROR_CATEGORIES as C, toGoogleBusinessApiError } from '../integrations/googleBusinessProfile/googleBusinessProfileErrors.js';
import { createPubSubPushVerifier, getPubSubPushConfig, isPubSubPushConfigured, parseGoogleBusinessNotification, PubSubAuthError } from '../integrations/googleBusinessProfile/googleBusinessProfilePubSub.js';

// Google rejects replies over 4096 bytes.
const MAX_REPLY_BYTES = 4096;
const LOCATION_CACHE_TTL_MS = 10 * 60 * 1000;
const MANUAL_SYNC_COOLDOWN_MS = 15 * 1000;
// Errors that describe the whole connection rather than one location.
const INTEGRATION_LEVEL = new Set([C.ACCESS_PENDING, C.API_DISABLED, C.INSUFFICIENT_SCOPE, C.TOKEN_EXPIRED, C.RECONNECT_REQUIRED, C.INVALID_CLIENT, C.NOT_CONNECTED, C.NOT_CONFIGURED]);
const ENV_NAMES = { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET', redirectUri: 'GOOGLE_REDIRECT_URI', scope: 'GOOGLE_BUSINESS_SCOPE' };

function returnUrlBase(env) {
  const configured = env.GOOGLE_BUSINESS_RETURN_URL || '';
  if (configured) return configured;
  const firstFrontend = String(env.FRONTEND_URLS || '').split(',').map(value => value.trim()).find(Boolean);
  return firstFrontend ? `${firstFrontend.replace(/\/+$/, '')}/service/reviews/google` : '';
}

export function createGoogleBusinessRouter({
  store,
  auth,
  allowRoles,
  env = process.env,
  verifyPubSubPush = createPubSubPushVerifier({ config: getPubSubPushConfig(env) }),
  reviewCache = createTransientReviewCache(),
  now = () => Date.now(),
  logger = console,
}) {
  const router = express.Router();
  const serviceOnly = [auth, allowRoles('iplanet_service')];
  const oauthConfig = () => getGoogleBusinessOauthConfig({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: env.GOOGLE_REDIRECT_URI, scope: env.GOOGLE_BUSINESS_SCOPE });
  const pubsubConfig = getPubSubPushConfig(env);
  let locationCache = null;
  const cooldowns = new Map();

  const sendError = (res, rawError, fallbackCategory = C.UNKNOWN) => {
    const error = rawError instanceof GoogleBusinessApiError ? rawError : new GoogleBusinessApiError(fallbackCategory);
    if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.portalStatus).json({ success: false, message: error.message, error: error.toJSON() });
  };
  const logFailure = (operation, error) => logger.warn(`[Google Business] ${operation} failed: ${error.category}${error.status ? ` (HTTP ${error.status}${error.reason ? ` ${error.reason}` : ''})` : ''}`);

  // ---- Token handling -----------------------------------------------------
  async function loadConnectedIntegration() {
    if (!validateGoogleBusinessOauthConfig(oauthConfig()).valid) throw new GoogleBusinessApiError(C.NOT_CONFIGURED);
    const integration = await store.getIntegration();
    if (!integration?.accessToken || integration.status === 'disconnected') throw new GoogleBusinessApiError(C.NOT_CONNECTED);
    if (integration.status === 'reconnect_required') throw new GoogleBusinessApiError(C.RECONNECT_REQUIRED);
    return integration;
  }

  async function refreshAccessToken(integration) {
    if (!integration.refreshToken) throw new GoogleBusinessApiError(C.RECONNECT_REQUIRED);
    let refreshed;
    try {
      refreshed = await refreshGoogleBusinessTokens({ refreshToken: decryptGoogleBusinessToken(integration.refreshToken), clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
    } catch (error) {
      const classified = toGoogleBusinessApiError(error);
      if (classified.category === C.RECONNECT_REQUIRED) await store.updateIntegration({ status: 'reconnect_required' });
      throw classified;
    }
    await store.updateIntegration({
      accessToken: encryptGoogleBusinessToken(refreshed.accessToken),
      ...(refreshed.refreshToken ? { refreshToken: encryptGoogleBusinessToken(refreshed.refreshToken) } : {}),
      tokenType: refreshed.tokenType || 'Bearer',
      expiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt) : null,
      status: 'connected',
    });
    return refreshed.accessToken;
  }

  // Runs `call(accessToken)` with a valid token, refreshing once on expiry,
  // and records the outcome on the integration.
  async function withGoogle(operation, call, { recordOutcome = true } = {}) {
    try {
      const integration = await loadConnectedIntegration();
      const expiresAt = integration.expiresAt ? new Date(integration.expiresAt).getTime() : 0;
      let token = expiresAt > now() + 60_000 ? decryptGoogleBusinessToken(integration.accessToken) : await refreshAccessToken(integration);
      let result;
      try {
        result = await call(token, integration);
      } catch (error) {
        if (toGoogleBusinessApiError(error).category !== C.TOKEN_EXPIRED) throw error;
        token = await refreshAccessToken(integration);
        result = await call(token, integration);
      }
      if (recordOutcome) await store.updateIntegration({ accessState: 'granted', lastErrorCategory: null, lastErrorMessage: null, lastErrorAt: null, lastCheckedAt: new Date(now()) });
      return result;
    } catch (rawError) {
      const error = toGoogleBusinessApiError(rawError);
      if (!(rawError instanceof GoogleBusinessApiError)) logger.error(`[Google Business] ${operation} failed unexpectedly: ${rawError?.name || 'Error'}`);
      else logFailure(operation, error);
      if (recordOutcome && INTEGRATION_LEVEL.has(error.category) && error.category !== C.NOT_CONNECTED && error.category !== C.NOT_CONFIGURED) {
        await store.updateIntegration({
          accessState: error.category === C.ACCESS_PENDING ? 'pending' : 'error',
          lastErrorCategory: error.category,
          lastErrorMessage: error.message,
          lastErrorAt: new Date(now()),
          lastCheckedAt: new Date(now()),
        }).catch(() => {});
      }
      throw error;
    }
  }

  async function discover({ refresh = false } = {}) {
    if (!refresh && locationCache && locationCache.expiresAt > now()) return locationCache.value;
    const value = await withGoogle('location discovery', token => discoverGoogleBusinessLocations(token));
    locationCache = { value, expiresAt: now() + LOCATION_CACHE_TTL_MS };
    return value;
  }

  const cooldownRemaining = (key, ms) => {
    const until = cooldowns.get(key) || 0;
    if (until > now()) return Math.ceil((until - now()) / 1000);
    cooldowns.set(key, now() + ms);
    return 0;
  };

  // ---- Status ---------------------------------------------------------------
  async function status(_req, res) {
    const diagnostics = validateGoogleBusinessOauthConfig(oauthConfig());
    const [integration, mappings] = await Promise.all([store.getIntegration(), store.listMappings()]);
    const connected = Boolean(integration?.accessToken) && integration?.status === 'connected';
    const lastSuccessfulSyncAt = mappings.map(mapping => mapping.lastReviewSyncAt).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
    res.json({
      success: true,
      mode: 'business-profile',
      configured: diagnostics.valid,
      missingConfiguration: diagnostics.missing.map(key => ENV_NAMES[key]),
      connected,
      connection: integration ? {
        status: integration.status,
        connectedAt: integration.connectedAt,
        scopeGranted: integration.grantedScope ? grantedScopeIncludesBusinessManage(integration.grantedScope) : null,
      } : null,
      access: {
        state: integration?.accessState || 'unknown',
        lastErrorCategory: integration?.lastErrorCategory || null,
        lastErrorMessage: integration?.lastErrorMessage || null,
        lastErrorAt: integration?.lastErrorAt || null,
        lastCheckedAt: integration?.lastCheckedAt || null,
      },
      mappingCount: mappings.length,
      lastSuccessfulSyncAt,
      reviewCacheTtlSeconds: Math.round(GOOGLE_REVIEW_CACHE_TTL_MS / 1000),
      notifications: {
        pushConfigured: isPubSubPushConfigured(pubsubConfig),
        topicConfigured: Boolean(pubsubConfig.topic),
        topic: pubsubConfig.topic || null,
        accountName: integration?.notificationAccountName || null,
        enabledAt: integration?.notificationsEnabledAt || null,
      },
    });
  }
  router.get('/status', serviceOnly, status);
  router.get('/health', serviceOnly, status);

  // ---- OAuth ----------------------------------------------------------------
  router.get('/auth', serviceOnly, async (req, res) => {
    const diagnostics = validateGoogleBusinessOauthConfig(oauthConfig());
    if (!diagnostics.valid) return sendError(res, new GoogleBusinessApiError(C.NOT_CONFIGURED));
    const integration = await store.getIntegration();
    const reconnect = req.query.reconnect === 'true' || req.query.reconnect === '1';
    if (integration?.accessToken && integration.status === 'connected' && !reconnect) {
      return res.status(409).json({ success: false, message: 'Google Business Profile is already connected. Use Reconnect only if access needs to be granted again.', error: { category: 'already_connected' } });
    }
    try {
      const state = createGoogleBusinessOAuthState({ userId: req.user.id, secret: env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY || env.JWT_SECRET });
      const url = buildGoogleBusinessAuthUrl({ ...oauthConfig(), state });
      return res.json({ success: true, url });
    } catch (error) {
      logger.error(`[Google Business] authorization URL unavailable: ${error.name}`);
      return sendError(res, new GoogleBusinessApiError(C.NOT_CONFIGURED));
    }
  });

  // Google redirects the browser here; the result is handed back to the portal.
  router.get('/callback', async (req, res) => {
    const finish = (outcome, category) => {
      const base = returnUrlBase(env);
      if (base) {
        const url = new URL(base);
        url.searchParams.set('google', outcome);
        if (category) url.searchParams.set('reason', category);
        return res.redirect(303, url.toString());
      }
      const ok = outcome === 'connected';
      return res.status(ok ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><title>Google Business Profile</title><p style="font:16px system-ui;padding:32px">${ok ? 'Google Business Profile is connected. You can close this tab and return to the iPlanet Service Portal.' : 'Google Business Profile could not be connected. Return to the iPlanet Service Portal for details.'}</p>`);
    };

    const { code, state, error } = req.query;
    if (error) return finish('error', error === 'access_denied' ? 'access_denied' : 'oauth_error');
    const verified = verifyGoogleBusinessOAuthState(state, { secret: env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY || env.JWT_SECRET, now: now() });
    if (!verified) return finish('error', 'invalid_state');
    if (!code || typeof code !== 'string') return finish('error', 'missing_code');
    const user = await store.getUser(verified.userId);
    if (!user || user.role !== 'iplanet_service') return finish('error', 'not_authorized');

    try {
      const exchange = await exchangeGoogleBusinessCodeForTokens({ code, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: env.GOOGLE_REDIRECT_URI });
      if (exchange.scope && !grantedScopeIncludesBusinessManage(exchange.scope)) {
        await revokeGoogleBusinessToken(exchange.refreshToken || exchange.accessToken);
        return finish('error', C.INSUFFICIENT_SCOPE);
      }
      const existing = await store.getIntegration();
      await store.upsertIntegration({
        userId: user._id,
        portalRole: 'iplanet_service',
        accessToken: encryptGoogleBusinessToken(exchange.accessToken),
        refreshToken: exchange.refreshToken ? encryptGoogleBusinessToken(exchange.refreshToken) : existing?.refreshToken || null,
        tokenType: exchange.tokenType || 'Bearer',
        expiresAt: exchange.expiresAt ? new Date(exchange.expiresAt) : null,
        grantedScope: exchange.scope || null,
        connectedAt: new Date(now()),
        status: 'connected',
        accessState: 'unknown',
        lastErrorCategory: null,
        lastErrorMessage: null,
        lastErrorAt: null,
      });
      locationCache = null;
      reviewCache.clear();
      return finish('connected');
    } catch (rawError) {
      const exchangeError = toGoogleBusinessApiError(rawError);
      logFailure('OAuth code exchange', exchangeError);
      return finish('error', exchangeError.category);
    }
  });

  router.delete('/connection', serviceOnly, async (req, res) => {
    const integration = await store.getIntegration();
    if (!integration || integration.status === 'disconnected') return res.json({ success: true, disconnected: true, revoked: false });
    // Turn off Pub/Sub delivery first; it needs a working token.
    if (integration.notificationAccountName && integration.status === 'connected') {
      await withGoogle('notification disable', token => updateGoogleBusinessNotificationSetting(integration.notificationAccountName, { pubsubTopic: '', notificationTypes: [] }, token), { recordOutcome: false }).catch(() => {});
    }
    const token = integration.refreshToken ? decryptGoogleBusinessToken(integration.refreshToken) : integration.accessToken ? decryptGoogleBusinessToken(integration.accessToken) : '';
    const revocation = await revokeGoogleBusinessToken(token);
    await store.updateIntegration({
      accessToken: null, refreshToken: null, expiresAt: null, grantedScope: null, status: 'disconnected', accessState: 'unknown',
      lastErrorCategory: null, lastErrorMessage: null, lastErrorAt: null, notificationAccountName: null, notificationTopic: null, notificationsEnabledAt: null,
    });
    locationCache = null;
    reviewCache.clear();
    logger.info(`[Google Business] Disconnected by user ${req.user.id}; revoked at Google: ${revocation.revoked}`);
    return res.json({ success: true, disconnected: true, revoked: revocation.revoked, mappingsKept: (await store.listMappings()).length });
  });

  // ---- Accounts and locations ----------------------------------------------
  async function accounts(_req, res) {
    try {
      const result = await withGoogle('account discovery', token => listGoogleBusinessAccounts(token));
      const safeAccounts = result.map(normalizeGoogleBusinessAccount).filter(Boolean);
      return res.json({ success: true, accounts: safeAccounts, accountCount: safeAccounts.length, message: safeAccounts.length ? undefined : 'The connected Google user cannot access any Business Profile accounts.' });
    } catch (error) {
      return sendError(res, error);
    }
  }
  router.get('/accounts', serviceOnly, accounts);
  router.post('/check', serviceOnly, (req, res, next) => {
    const wait = cooldownRemaining('check', 5000);
    if (wait) return res.status(429).set('Retry-After', String(wait)).json({ success: false, message: `Please wait ${wait}s before checking again.`, error: { category: 'cooldown', retryAfterSeconds: wait } });
    return accounts(req, res, next);
  });

  router.get('/locations', serviceOnly, async (req, res) => {
    try {
      const { accounts: rawAccounts, locations } = await discover({ refresh: req.query.refresh === 'true' });
      const mappings = await store.listMappings();
      const byLocation = new Map(mappings.map(mapping => [mapping.locationName, mapping]));
      const accessible = new Set(locations.map(location => location.locationName));
      return res.json({
        success: true,
        accounts: rawAccounts.map(normalizeGoogleBusinessAccount).filter(Boolean),
        locations: locations.map(location => {
          const mapping = byLocation.get(location.locationName);
          return { ...location, mapping: mapping ? { mappingId: String(mapping._id), serviceCentreId: String(mapping.serviceCentreId), serviceCentreName: mapping.serviceCentreName } : null };
        }),
        // Mappings whose location the connected user can no longer access.
        inaccessibleMappings: mappings.filter(mapping => !accessible.has(mapping.locationName)).map(mapping => ({ mappingId: String(mapping._id), locationName: mapping.locationName, locationDisplayName: mapping.locationDisplayName, serviceCentreName: mapping.serviceCentreName })),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/mappings', serviceOnly, async (_req, res) => {
    const mappings = await store.listMappings();
    res.json({ success: true, mappings: mappings.map(publicMapping) });
  });

  router.post('/locations/map', serviceOnly, async (req, res) => {
    const { locationName, serviceCentreId } = req.body || {};
    if (!isGoogleLocationName(locationName) || !serviceCentreId) return res.status(400).json({ success: false, message: 'A Google location and an iPlanet service centre are required.' });
    const serviceCentre = await store.getActiveServiceCentre(serviceCentreId);
    if (!serviceCentre) return res.status(404).json({ success: false, message: 'Service centre not found or inactive.' });
    let discovered;
    try {
      discovered = await discover({ refresh: false });
      if (!discovered.locations.some(location => location.locationName === locationName)) discovered = await discover({ refresh: true });
    } catch (error) {
      return sendError(res, error);
    }
    // Never trust the browser's location: it must be one the connected Google user can access.
    const location = discovered.locations.find(item => item.locationName === locationName);
    if (!location) return res.status(403).json({ success: false, message: 'This Google location is not accessible through the connected Business Profile account.' });
    const mapping = await store.saveMapping({
      serviceCentreId: serviceCentre._id,
      serviceCentreName: serviceCentre.name,
      locationName: location.locationName,
      locationDisplayName: location.title || location.locationName,
      accountName: location.accountName,
      mapsUri: location.mapsUri,
      syncStatus: 'pending',
    });
    reviewCache.invalidate(String(mapping._id));
    return res.status(201).json({ success: true, mapping: publicMapping(mapping) });
  });

  router.delete('/locations/map/:mappingId', serviceOnly, async (req, res) => {
    const mapping = await store.getMapping(req.params.mappingId);
    if (!mapping) return res.status(404).json({ success: false, message: 'Mapping not found.' });
    await store.deleteMapping(mapping._id);
    reviewCache.invalidate(String(mapping._id));
    return res.json({ success: true });
  });

  // ---- Reviews ---------------------------------------------------------------
  async function fetchLocationReviews(mapping, { pageToken = '', pageSize = GOOGLE_REVIEWS_MAX_PAGE_SIZE, force = false } = {}) {
    const cacheKey = `${mapping._id}|${pageToken}|${pageSize}`;
    if (!force) {
      const cached = reviewCache.get(cacheKey);
      if (cached) return { ...cached, fromCache: true };
    }
    const locationPath = googleReviewsLocationPath(mapping.accountName, mapping.locationName);
    await store.updateMapping(mapping._id, { lastSyncAttemptAt: new Date(now()) });
    try {
      const page = await withGoogle('review retrieval', token => getGoogleBusinessReviews(locationPath, token, pageToken, { pageSize }));
      const reviews = page.reviews.map(review => normalizeGoogleBusinessReview(review, { mappingId: mapping._id, locationName: mapping.locationName, title: mapping.locationDisplayName, serviceCentreId: mapping.serviceCentreId, serviceCentreName: mapping.serviceCentreName, mapsUri: mapping.mapsUri })).filter(Boolean);
      const result = { reviews, nextPageToken: page.nextPageToken, googleReportedTotal: page.totalReviewCount, googleReportedAverage: page.averageRating, fetchedAt: new Date(now()).toISOString() };
      reviewCache.set(cacheKey, result);
      await store.updateMapping(mapping._id, {
        syncStatus: 'ok', lastErrorCategory: null, nextRetryAt: null, lastReviewSyncAt: new Date(now()),
        ...(pageToken ? {} : { lastSyncedReviewCount: reviews.length }),
      });
      return { ...result, fromCache: false };
    } catch (error) {
      await store.updateMapping(mapping._id, {
        syncStatus: 'error',
        lastErrorCategory: error.category,
        nextRetryAt: error.retryable && error.retryAfterSeconds ? new Date(now() + error.retryAfterSeconds * 1000) : null,
      });
      throw error;
    }
  }

  const locationEnvelope = mapping => ({ mappingId: String(mapping._id), locationName: mapping.locationName, title: mapping.locationDisplayName || null, serviceCentreId: String(mapping.serviceCentreId), serviceCentreName: mapping.serviceCentreName || null, mapsUri: mapping.mapsUri || null });

  router.get('/reviews', serviceOnly, async (req, res) => {
    const pageSize = Math.min(GOOGLE_REVIEWS_MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || GOOGLE_REVIEWS_MAX_PAGE_SIZE));
    const pageToken = typeof req.query.pageToken === 'string' ? req.query.pageToken.slice(0, 512) : '';
    let mappings = await store.listMappings();
    if (req.query.mappingId) {
      mappings = mappings.filter(mapping => String(mapping._id) === String(req.query.mappingId));
      if (!mappings.length) return res.status(404).json({ success: false, message: 'Mapped Google location not found.' });
    } else if (pageToken) {
      return res.status(400).json({ success: false, message: 'pageToken requires mappingId.' });
    }
    if (!mappings.length) return res.json({ success: true, scope: 'retrieved', locations: [], summary: summarizeRetrievedReviews([]) });

    const locations = [];
    for (const mapping of mappings) {
      try {
        locations.push({ ...locationEnvelope(mapping), ...(await fetchLocationReviews(mapping, { pageToken, pageSize })), error: null });
      } catch (rawError) {
        const error = toGoogleBusinessApiError(rawError);
        // A connection-wide problem (e.g. access pending) applies to every location.
        if (INTEGRATION_LEVEL.has(error.category)) return sendError(res, error);
        locations.push({ ...locationEnvelope(mapping), reviews: [], nextPageToken: null, error: error.toJSON() });
      }
    }
    return res.json({ success: true, scope: 'retrieved', locations, summary: summarizeRetrievedReviews(locations.flatMap(location => location.reviews)) });
  });

  router.post('/locations/:mappingId/sync', serviceOnly, async (req, res) => {
    const mapping = await store.getMapping(req.params.mappingId);
    if (!mapping) return res.status(404).json({ success: false, message: 'Mapped Google location not found.' });
    const wait = cooldownRemaining(`sync:${mapping._id}`, MANUAL_SYNC_COOLDOWN_MS);
    if (wait) return res.status(429).set('Retry-After', String(wait)).json({ success: false, message: `This location was synced moments ago. Try again in ${wait}s.`, error: { category: 'cooldown', retryAfterSeconds: wait } });
    reviewCache.invalidate(String(mapping._id));
    try {
      const result = await fetchLocationReviews(mapping, { force: true });
      return res.json({ success: true, scope: 'retrieved', location: { ...locationEnvelope(mapping), ...result, error: null }, summary: summarizeRetrievedReviews(result.reviews) });
    } catch (error) {
      return sendError(res, toGoogleBusinessApiError(error));
    }
  });

  // ---- Replies ---------------------------------------------------------------
  async function replyTarget(req, res) {
    if (!isGoogleReviewId(req.params.reviewId)) { res.status(400).json({ success: false, message: 'Invalid Google review ID.' }); return null; }
    const mapping = await store.getMapping(req.params.mappingId);
    if (!mapping) { res.status(404).json({ success: false, message: 'Mapped Google location not found.' }); return null; }
    if (req.body?.confirmed !== true) { res.status(400).json({ success: false, message: 'Replies are published publicly on Google and must be explicitly confirmed.' }); return null; }
    return { mapping, locationPath: googleReviewsLocationPath(mapping.accountName, mapping.locationName) };
  }
  const freshReview = async (target, reviewId) => {
    reviewCache.invalidate(String(target.mapping._id));
    const review = await withGoogle('review refresh', token => getGoogleBusinessReview(target.locationPath, reviewId, token));
    return normalizeGoogleBusinessReview(review, { mappingId: target.mapping._id, locationName: target.mapping.locationName, title: target.mapping.locationDisplayName, serviceCentreId: target.mapping.serviceCentreId, serviceCentreName: target.mapping.serviceCentreName, mapsUri: target.mapping.mapsUri });
  };

  router.put('/locations/:mappingId/reviews/:reviewId/reply', serviceOnly, async (req, res) => {
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
    if (!comment) return res.status(400).json({ success: false, message: 'Reply text is required.' });
    if (Buffer.byteLength(comment, 'utf8') > MAX_REPLY_BYTES) return res.status(400).json({ success: false, message: `Replies are limited to ${MAX_REPLY_BYTES} bytes.` });
    try {
      const target = await replyTarget(req, res);
      if (!target) return undefined;
      await withGoogle('reply update', token => updateGoogleBusinessReviewReply(target.locationPath, req.params.reviewId, comment, token));
      logger.info(`[Google Business] Reply published by user ${req.user.id} on mapping ${target.mapping._id}`);
      const review = await freshReview(target, req.params.reviewId).catch(() => null);
      return res.json({ success: true, review, refreshed: Boolean(review) });
    } catch (error) {
      return sendError(res, toGoogleBusinessApiError(error));
    }
  });

  router.delete('/locations/:mappingId/reviews/:reviewId/reply', serviceOnly, async (req, res) => {
    try {
      const target = await replyTarget(req, res);
      if (!target) return undefined;
      await withGoogle('reply delete', token => deleteGoogleBusinessReviewReply(target.locationPath, req.params.reviewId, token));
      logger.info(`[Google Business] Reply deleted by user ${req.user.id} on mapping ${target.mapping._id}`);
      const review = await freshReview(target, req.params.reviewId).catch(() => null);
      return res.json({ success: true, review, refreshed: Boolean(review) });
    } catch (error) {
      return sendError(res, toGoogleBusinessApiError(error));
    }
  });

  // ---- Pub/Sub notification settings -----------------------------------------
  async function accessibleAccount(accountName) {
    if (!isGoogleAccountName(accountName)) return false;
    const list = await withGoogle('account discovery', token => listGoogleBusinessAccounts(token));
    return list.some(account => account.name === accountName);
  }

  router.get('/notifications', serviceOnly, async (req, res) => {
    const accountName = String(req.query.accountName || '');
    try {
      if (!(await accessibleAccount(accountName))) return res.status(403).json({ success: false, message: 'This Google account is not accessible through the connected integration.' });
      const setting = await withGoogle('notification setting read', token => getGoogleBusinessNotificationSetting(accountName, token));
      return res.json({ success: true, setting: { pubsubTopic: setting.pubsubTopic || null, notificationTypes: Array.isArray(setting.notificationTypes) ? setting.notificationTypes : [] }, expectedTopic: pubsubConfig.topic || null });
    } catch (error) {
      return sendError(res, toGoogleBusinessApiError(error));
    }
  });

  router.put('/notifications', serviceOnly, async (req, res) => {
    const { accountName, enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, message: 'enabled must be true or false.' });
    if (enabled && !pubsubConfig.topic) return res.status(409).json({ success: false, message: 'GOOGLE_PUBSUB_TOPIC is not configured on the backend.' });
    if (enabled && !isPubSubPushConfigured(pubsubConfig)) return res.status(409).json({ success: false, message: 'Pub/Sub push authentication (GOOGLE_PUBSUB_PUSH_AUDIENCE, GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT) is not configured on the backend.' });
    try {
      if (!(await accessibleAccount(accountName))) return res.status(403).json({ success: false, message: 'This Google account is not accessible through the connected integration.' });
      const setting = await withGoogle('notification setting update', token => updateGoogleBusinessNotificationSetting(accountName, enabled ? { pubsubTopic: pubsubConfig.topic, notificationTypes: GOOGLE_REVIEW_NOTIFICATION_TYPES } : { pubsubTopic: '', notificationTypes: [] }, token));
      await store.updateIntegration(enabled
        ? { notificationAccountName: accountName, notificationTopic: pubsubConfig.topic, notificationsEnabledAt: new Date(now()) }
        : { notificationAccountName: null, notificationTopic: null, notificationsEnabledAt: null });
      return res.json({ success: true, setting: { pubsubTopic: setting.pubsubTopic || null, notificationTypes: Array.isArray(setting.notificationTypes) ? setting.notificationTypes : [] } });
    } catch (error) {
      return sendError(res, toGoogleBusinessApiError(error));
    }
  });

  // ---- Pub/Sub push endpoint -------------------------------------------------
  // Pub/Sub treats 2xx as an acknowledgement. Malformed messages are
  // acknowledged (redelivery cannot fix them) but recorded; processing
  // failures answer 500 so Pub/Sub redelivers.
  router.post('/pubsub', async (req, res) => {
    try {
      await verifyPubSubPush(req.headers.authorization);
    } catch (error) {
      logger.warn(`[Google Business] Pub/Sub push rejected: ${error instanceof PubSubAuthError ? error.message : 'verification error'}`);
      return res.status(error instanceof PubSubAuthError && /not configured/.test(error.message) ? 503 : 401).json({ success: false });
    }

    const parsed = parseGoogleBusinessNotification(req.body);
    if (!parsed.ok) {
      logger.warn(`[Google Business] Pub/Sub message ${parsed.messageId || '(no id)'} ignored: ${parsed.reason}`);
      if (parsed.messageId) await store.recordNotificationReceipt({ messageId: parsed.messageId, type: 'INVALID' }).then(() => store.updateNotificationReceipt(parsed.messageId, { status: 'ignored', outcome: parsed.reason })).catch(() => {});
      return res.status(204).end();
    }

    const eventKey = parsed.type === 'NEW_REVIEW' && parsed.reviewId ? `NEW_REVIEW:${parsed.location}/reviews/${parsed.reviewId}` : null;
    let receipt;
    try {
      receipt = await store.recordNotificationReceipt({ messageId: parsed.messageId, eventKey, type: parsed.type, location: parsed.location });
    } catch {
      return res.status(500).json({ success: false });
    }
    if (receipt === 'duplicate') return res.status(204).end();

    try {
      if (!parsed.relevant) {
        await store.updateNotificationReceipt(parsed.messageId, { status: 'ignored', outcome: 'unsupported_type' });
        return res.status(204).end();
      }
      const mapping = await store.findMappingByLocation(parsed.accountName, parsed.locationName);
      if (!mapping) {
        await store.updateNotificationReceipt(parsed.messageId, { status: 'ignored', outcome: 'unmapped_location' });
        return res.status(204).end();
      }
      reviewCache.invalidate(String(mapping._id));
      await store.updateMapping(mapping._id, { lastNotificationAt: new Date(now()), syncStatus: 'pending' });
      const users = await store.serviceUsersForCentre(mapping.serviceCentreId);
      const place = mapping.serviceCentreName || mapping.locationDisplayName || 'a mapped location';
      // Operational alert only; review text and reviewer details stay at Google.
      await store.createNotifications(users.map(user => ({
        user: user._id,
        serviceCentreId: mapping.serviceCentreId,
        portalRole: user.role,
        type: 'GOOGLE_REVIEW_ACTIVITY',
        priority: 'normal',
        title: parsed.type === 'NEW_REVIEW' ? 'New Google review' : 'Google review updated',
        message: `${parsed.type === 'NEW_REVIEW' ? 'New' : 'Updated'} Google review activity detected for ${place}.`,
        action: { route: `/service/reviews/google?location=${mapping._id}` },
        read: false,
      })));
      await store.updateNotificationReceipt(parsed.messageId, { status: 'processed', outcome: `notified_${users.length}` });
      return res.status(204).end();
    } catch {
      logger.error(`[Google Business] Pub/Sub message ${parsed.messageId} processing failed`);
      await store.updateNotificationReceipt(parsed.messageId, { status: 'failed', outcome: 'processing_error' }).catch(() => {});
      return res.status(500).json({ success: false });
    }
  });

  return router;
}

function publicMapping(mapping) {
  return {
    mappingId: String(mapping._id),
    serviceCentreId: String(mapping.serviceCentreId),
    serviceCentreName: mapping.serviceCentreName || null,
    locationName: mapping.locationName,
    locationDisplayName: mapping.locationDisplayName || null,
    accountName: mapping.accountName || null,
    mapsUri: mapping.mapsUri || null,
    mappedAt: mapping.mappedAt || null,
    syncStatus: mapping.syncStatus || 'never',
    lastSyncAttemptAt: mapping.lastSyncAttemptAt || null,
    lastSuccessfulSyncAt: mapping.lastReviewSyncAt || null,
    lastErrorCategory: mapping.lastErrorCategory || null,
    nextRetryAt: mapping.nextRetryAt || null,
    lastNotificationAt: mapping.lastNotificationAt || null,
    lastRetrievedCount: mapping.lastSyncedReviewCount ?? null,
  };
}
