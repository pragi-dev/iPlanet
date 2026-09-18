import crypto from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage';

export class GoogleBusinessProfileError extends Error {
  constructor(message, code = 'GOOGLE_BUSINESS_ERROR', statusCode = 502) {
    super(message);
    this.name = 'GoogleBusinessProfileError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function encryptionKey(environment = process.env) {
  const secret = environment.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY || environment.GOOGLE_BUSINESS_CLIENT_SECRET || environment.JWT_SECRET || 'local-demo-secret';
  return crypto.createHash('sha256').update(String(secret)).update('iplanet-google-business-refresh-token').digest();
}

export function encryptGoogleBusinessRefreshToken(token, environment = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(environment), iv);
  const encrypted = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptGoogleBusinessRefreshToken(value, environment = process.env) {
  if (!value) return '';
  const [version, ivText, tagText, encryptedText] = String(value).split(':');
  if (version !== 'v1') return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(environment), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function buildGoogleBusinessAuthUrl(environment = process.env, state = '') {
  if (!environment.GOOGLE_BUSINESS_CLIENT_ID || !environment.GOOGLE_BUSINESS_CLIENT_SECRET || !environment.GOOGLE_BUSINESS_REDIRECT_URI) throw new GoogleBusinessProfileError('Google Business Profile OAuth is not configured.', 'GOOGLE_BUSINESS_OAUTH_NOT_CONFIGURED', 503);
  const params = new URLSearchParams({ client_id: environment.GOOGLE_BUSINESS_CLIENT_ID, redirect_uri: environment.GOOGLE_BUSINESS_REDIRECT_URI, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: GOOGLE_BUSINESS_SCOPE, state });
  return `${AUTH_ENDPOINT}?${params}`;
}

export async function googleRequest(url, options, fetchImpl = fetch) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new GoogleBusinessProfileError(body.error?.message || body.error_description || `Google Business Profile request failed (${response.status})`, response.status === 401 ? 'GOOGLE_BUSINESS_AUTH_FAILED' : 'GOOGLE_BUSINESS_API_FAILED', response.status);
  return body;
}

export async function exchangeGoogleBusinessCode(code, environment = process.env, fetchImpl = fetch) {
  if (!code) throw new GoogleBusinessProfileError('Google OAuth authorization code is missing.', 'GOOGLE_BUSINESS_CODE_MISSING', 400);
  return googleRequest(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: environment.GOOGLE_BUSINESS_CLIENT_ID, client_secret: environment.GOOGLE_BUSINESS_CLIENT_SECRET, redirect_uri: environment.GOOGLE_BUSINESS_REDIRECT_URI, grant_type: 'authorization_code' }) }, fetchImpl);
}

export async function refreshGoogleBusinessAccessToken(refreshToken, environment = process.env, fetchImpl = fetch) {
  if (!refreshToken) throw new GoogleBusinessProfileError('Google Business Profile is not connected.', 'GOOGLE_BUSINESS_REFRESH_TOKEN_MISSING', 503);
  const result = await googleRequest(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ refresh_token: refreshToken, client_id: environment.GOOGLE_BUSINESS_CLIENT_ID, client_secret: environment.GOOGLE_BUSINESS_CLIENT_SECRET, grant_type: 'refresh_token' }) }, fetchImpl);
  if (!result.access_token) throw new GoogleBusinessProfileError('Google did not return an access token.', 'GOOGLE_BUSINESS_TOKEN_REFRESH_FAILED', 502);
  return result;
}
