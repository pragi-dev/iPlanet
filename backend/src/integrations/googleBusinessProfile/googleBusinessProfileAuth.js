import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const GOOGLE_BUSINESS_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_BUSINESS_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_BUSINESS_SCOPE = process.env.GOOGLE_BUSINESS_SCOPE || process.env.GOOGLE_SCOPE || 'https://www.googleapis.com/auth/business.manage';

function getGoogleBusinessOauthConfig({ clientId, clientSecret, redirectUri } = {}) {
  return {
    clientId: clientId || process.env.GOOGLE_BUSINESS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: clientSecret || process.env.GOOGLE_BUSINESS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: redirectUri || process.env.GOOGLE_BUSINESS_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || '',
  };
}

export async function exchangeGoogleBusinessCodeForTokens({ code, clientId, clientSecret, redirectUri } = {}) {
  const config = getGoogleBusinessOauthConfig({ clientId, clientSecret, redirectUri });
  if (!code || !config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error('Google Business Profile OAuth is not configured. Missing client ID, secret, redirect URI, or authorization code.');
  }

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

  if (!token || !config.clientId || !config.clientSecret) {
    throw new Error('Google Business Profile refresh requires a stored refresh token and OAuth credentials.');
  }

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
  scope = GOOGLE_BUSINESS_SCOPE,
} = {}) {
  const config = getGoogleBusinessOauthConfig({ clientId, redirectUri });
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope,
    access_type: accessType,
    prompt,
    include_granted_scopes: String(includeGrantedScopes),
    state: state || JSON.stringify({ ts: Date.now() }),
  });

  return `${GOOGLE_BUSINESS_OAUTH_URL}?${params.toString()}`;
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
