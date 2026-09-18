import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleBusinessAuthUrl, parseGoogleBusinessState } from './googleBusinessProfileAuth.js';

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
