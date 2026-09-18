import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleBusinessAuthUrl, parseGoogleBusinessState, exchangeGoogleBusinessCodeForTokens, refreshGoogleBusinessTokens } from './googleBusinessProfileAuth.js';

test('buildGoogleBusinessAuthUrl includes required OAuth parameters', () => {
  const url = buildGoogleBusinessAuthUrl({
    clientId: 'test-client-id',
    redirectUri: 'http://localhost:5000/api/google-business/callback',
    state: JSON.stringify({ companyId: 'company-123', userId: 'user-456' })
  });

  assert.match(url, /^https:\/\/accounts.google.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(url, /client_id=test-client-id/);
  assert.match(url, /redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fapi%2Fgoogle-business%2Fcallback/);
  assert.match(url, /scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fbusiness.manage/);
  assert.match(url, /state=/);
});

test('parseGoogleBusinessState reads encoded OAuth state', () => {
  const value = JSON.stringify({ companyId: 'company-123', userId: 'user-456' });
  const parsed = parseGoogleBusinessState(value);

  assert.deepEqual(parsed, { companyId: 'company-123', userId: 'user-456' });
});

test('buildGoogleBusinessAuthUrl falls back to the active Google OAuth env vars', () => {
  const url = buildGoogleBusinessAuthUrl({
    clientId: '',
    redirectUri: '',
    state: JSON.stringify({ companyId: 'company-123', userId: 'user-456' }),
  });

  assert.match(url, /client_id=353090434146-5ttsesn1vok7k9kdk1mn2558dco06ioe.apps.googleusercontent.com/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fiplanet-backend.onrender.com%2Fapi%2Fgoogle%2Fcallback/);
});

test('Google OAuth token helpers build the expected grant request payloads', async () => {
  await assert.rejects(() => exchangeGoogleBusinessCodeForTokens({
    code: 'test-code',
    clientId: 'client-123',
    clientSecret: 'secret-123',
    redirectUri: 'http://localhost:5000/api/google-business/callback',
  }), /Failed to exchange/);

  await assert.rejects(() => refreshGoogleBusinessTokens({
    refreshToken: 'refresh-123',
    clientId: 'client-123',
    clientSecret: 'secret-123',
  }), /Failed to refresh/);
});
