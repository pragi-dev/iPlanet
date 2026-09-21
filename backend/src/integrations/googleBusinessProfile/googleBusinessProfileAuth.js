import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const GOOGLE_BUSINESS_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_BUSINESS_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function getGoogleBusinessOauthConfig({ clientId, clientSecret, redirectUri, scope } = {}) {
  return {
    clientId: clientId || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: clientSecret || process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: redirectUri || process.env.GOOGLE_REDIRECT_URI || '',
    scope: scope || process.env.GOOGLE_BUSINESS_SCOPE || '',
  };
}

export function validateGoogleBusinessOauthConfig(config = getGoogleBusinessOauthConfig()) {
  const missing = ['clientId', 'clientSecret', 'redirectUri', 'scope'].filter(key => !String(config[key] || '').trim());
  return {
    valid: missing.length === 0,
    missing,
    clientIdConfigured: Boolean(config.clientId),
    clientSecretConfigured: Boolean(config.clientSecret),
    redirectUriConfigured: Boolean(config.redirectUri),
    scopeConfigured: Boolean(config.scope),
  };
}

export function inspectGoogleBusinessAuthUrl(rawUrl) {
  const url = new URL(rawUrl);
  const requiredParameters = ['client_id', 'redirect_uri', 'response_type', 'scope', 'access_type', 'state'];
  return Object.fromEntries(requiredParameters.map(parameter => [parameter, Boolean(url.searchParams.get(parameter))]));
}

function requireGoogleBusinessOauthConfig(config) {
  const diagnostics = validateGoogleBusinessOauthConfig(config);
  if (!diagnostics.valid) {
    throw new Error(`Google OAuth is not configured. Missing: ${diagnostics.missing.map(key => ({ clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET', redirectUri: 'GOOGLE_REDIRECT_URI', scope: 'GOOGLE_BUSINESS_SCOPE' }[key])).join(', ')}`);
  }
}

export async function exchangeGoogleBusinessCodeForTokens({ code, clientId, clientSecret, redirectUri } = {}) {
  const config = getGoogleBusinessOauthConfig({ clientId, clientSecret, redirectUri });
  requireGoogleBusinessOauthConfig(config);
  if (!code) throw new Error('Google authorization code is missing.');

  const params = new URLSearchParams({
    code: String(code),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch(GOOGLE_BUSINESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error_description || payload?.error || 'Unknown OAuth error';
    throw new Error(`Failed to exchange Google authorization code: ${response.status} ${message}`);
  }

  return {
    accessToken: payload.access_token || '',
    refreshToken: payload.refresh_token || '',
    scope: payload.scope || '',
    tokenType: payload.token_type || 'Bearer',
    expiresIn: Number(payload.expires_in) || 0,
    expiresAt: payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : null,
    idToken: payload.id_token || '',
    raw: payload,
  };
}

export async function refreshGoogleBusinessTokens({ refreshToken, clientId, clientSecret } = {}) {
  const config = getGoogleBusinessOauthConfig({ clientId, clientSecret });
  const token = refreshToken || process.env.GOOGLE_BUSINESS_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN || '';

  requireGoogleBusinessOauthConfig(config);
  if (!token) throw new Error('Google Business Profile refresh requires a stored refresh token.');

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: token,
    grant_type: 'refresh_token',
  });

  const response = await fetch(GOOGLE_BUSINESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error_description || payload?.error || 'Unknown refresh error';
    throw new Error(`Failed to refresh Google access token: ${response.status} ${message}`);
  }

  return {
    accessToken: payload.access_token || '',
    scope: payload.scope || '',
    tokenType: payload.token_type || 'Bearer',
    expiresIn: Number(payload.expires_in) || 0,
    expiresAt: payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : null,
    refreshToken: payload.refresh_token || token,
    raw: payload,
  };
}

export function buildGoogleBusinessAuthUrl({
  clientId,
  redirectUri,
  state,
  accessType = 'offline',
  prompt = 'consent',
  includeGrantedScopes = true,
  scope,
} = {}) {
  const config = getGoogleBusinessOauthConfig({ clientId, redirectUri });
  requireGoogleBusinessOauthConfig({ ...config, scope: scope || config.scope });
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scope || config.scope,
    access_type: accessType,
    prompt,
    include_granted_scopes: String(includeGrantedScopes),
    state: state || JSON.stringify({ ts: Date.now() }),
  });

  const url = `${GOOGLE_BUSINESS_OAUTH_URL}?${params.toString()}`;
  const diagnostics = inspectGoogleBusinessAuthUrl(url);
  if (Object.values(diagnostics).some(value => !value)) throw new Error('Generated Google OAuth URL is missing a required parameter.');
  return url;
}

export function parseGoogleBusinessState(rawState) {
  if (!rawState) return {};
  try {
    return typeof rawState === 'string' ? JSON.parse(rawState) : rawState;
  } catch {
    return { rawState };
  }
}

export function encryptGoogleBusinessToken(value, secretKey = process.env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET) {
  if (!value) return '';
  if (!secretKey) return value;
  const key = crypto.createHash('sha256').update(String(secretKey)).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptGoogleBusinessToken(value, secretKey = process.env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET) {
  if (!value) return '';
  if (!secretKey || !String(value).includes(':')) return value;
  const [ivHex, encryptedHex] = String(value).split(':');
  const key = crypto.createHash('sha256').update(String(secretKey)).digest();
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
