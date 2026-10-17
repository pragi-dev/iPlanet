import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

// Authenticated Pub/Sub push: the subscription is configured with a service
// account, and Pub/Sub sends "Authorization: Bearer <Google-signed OIDC JWT>".
// The token is verified against Google's public keys, the configured audience
// and the configured service-account email before anything is processed.
const GOOGLE_OIDC_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_OIDC_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const DEFAULT_CERT_TTL_MS = 60 * 60 * 1000;

const NOTIFICATION_TYPES = ['NEW_REVIEW', 'UPDATED_REVIEW'];
const LOCATION_RESOURCE = /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+$/;
const REVIEW_RESOURCE = /^(accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+)\/reviews\/([A-Za-z0-9_-]+)$/;
const MAX_MESSAGE_BYTES = 16 * 1024;

export class PubSubAuthError extends Error {
  constructor(message) { super(message); this.name = 'PubSubAuthError'; }
}

export function getPubSubPushConfig(env = process.env) {
  return {
    audience: env.GOOGLE_PUBSUB_PUSH_AUDIENCE || '',
    serviceAccountEmail: env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT || '',
    topic: env.GOOGLE_PUBSUB_TOPIC || '',
  };
}

export function isPubSubPushConfigured(config = getPubSubPushConfig()) {
  return Boolean(config.audience && config.serviceAccountEmail);
}

async function fetchGoogleJwks() {
  const response = await fetch(GOOGLE_OIDC_CERTS_URL);
  if (!response.ok) throw new PubSubAuthError('Unable to load Google signing keys.');
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1]);
  const body = await response.json();
  return { keys: Array.isArray(body.keys) ? body.keys : [], ttlMs: Number.isFinite(maxAge) ? maxAge * 1000 : DEFAULT_CERT_TTL_MS };
}

export function createPubSubPushVerifier({ config = getPubSubPushConfig(), loadJwks = fetchGoogleJwks, now = () => Date.now() } = {}) {
  let cache = { keys: [], expiresAt: 0 };
  const keyFor = async kid => {
    if (!cache.keys.some(key => key.kid === kid) || cache.expiresAt <= now()) {
      const loaded = await loadJwks();
      cache = { keys: loaded.keys, expiresAt: now() + (loaded.ttlMs || DEFAULT_CERT_TTL_MS) };
    }
    const jwk = cache.keys.find(key => key.kid === kid);
    if (!jwk) throw new PubSubAuthError('Push token was signed with an unknown key.');
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  };

  return async function verifyPubSubPush(authorizationHeader) {
    if (!isPubSubPushConfigured(config)) throw new PubSubAuthError('Pub/Sub push authentication is not configured.');
    const match = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader || ''));
    if (!match) throw new PubSubAuthError('Missing push authentication token.');
    const decoded = jwt.decode(match[1], { complete: true });
    if (!decoded?.header?.kid || decoded.header.alg !== 'RS256') throw new PubSubAuthError('Malformed push authentication token.');
    let claims;
    try {
      claims = jwt.verify(match[1], await keyFor(decoded.header.kid), {
        algorithms: ['RS256'],
        audience: config.audience,
        issuer: GOOGLE_OIDC_ISSUERS,
        clockTimestamp: Math.floor(now() / 1000),
      });
    } catch (error) {
      if (error instanceof PubSubAuthError) throw error;
      throw new PubSubAuthError('Push authentication token is invalid.');
    }
    if (claims.email !== config.serviceAccountEmail || claims.email_verified !== true) throw new PubSubAuthError('Push token was not issued for the configured service account.');
    return { email: claims.email };
  };
}

// Parses a Pub/Sub push envelope and the Business Profile notification inside
// it. Returns { ok: true, ... } or { ok: false, reason }.
export function parseGoogleBusinessNotification(body) {
  const message = body?.message;
  if (!message || typeof message !== 'object') return { ok: false, reason: 'missing_message' };
  const messageId = String(message.messageId || message.message_id || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(messageId)) return { ok: false, reason: 'invalid_message_id' };
  if (typeof message.data !== 'string' || !message.data) return { ok: false, reason: 'missing_data', messageId };
  if (message.data.length > MAX_MESSAGE_BYTES * 2) return { ok: false, reason: 'message_too_large', messageId };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'undecodable_data', messageId };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'invalid_payload', messageId };

  const type = String(payload.type || '');
  const reviewMatch = typeof payload.review === 'string' ? REVIEW_RESOURCE.exec(payload.review) : null;
  const location = typeof payload.location === 'string' && LOCATION_RESOURCE.test(payload.location) ? payload.location : reviewMatch?.[1] || null;

  if (!type) return { ok: false, reason: 'missing_type', messageId };
  if (!location) return { ok: false, reason: 'missing_location', messageId };

  return {
    ok: true,
    messageId,
    type,
    relevant: NOTIFICATION_TYPES.includes(type),
    location,
    locationName: location.split('/').slice(2).join('/'),
    accountName: location.split('/').slice(0, 2).join('/'),
    reviewId: reviewMatch?.[2] || null,
    publishTime: typeof message.publishTime === 'string' ? message.publishTime : null,
  };
}
