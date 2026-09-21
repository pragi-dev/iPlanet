import test from 'node:test';
import assert from 'node:assert/strict';
import { listGoogleBusinessAccounts, listGoogleBusinessLocations } from './googleBusinessProfileProvider.js';

test('listGoogleBusinessAccounts calls the Account Management API', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ accounts: [{ name: 'accounts/123', accountName: 'Demo account' }] }), { status: 200 });
  };

  try {
    const accounts = await listGoogleBusinessAccounts('access-token');
    assert.deepEqual(accounts, [{ name: 'accounts/123', accountName: 'Demo account' }]);
    assert.equal(request.url, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
    assert.equal(request.options.headers.Authorization, 'Bearer access-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listGoogleBusinessLocations calls Business Information with a read mask and page token', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  globalThis.fetch = async url => {
    requestUrl = String(url);
    return new Response(JSON.stringify({ locations: [{ name: 'locations/456', title: 'Demo location' }], nextPageToken: 'next-page' }), { status: 200 });
  };

  try {
    const page = await listGoogleBusinessLocations('accounts/123', 'access-token', 'page one');
    const parsedUrl = new URL(requestUrl);
    assert.equal(parsedUrl.origin, 'https://mybusinessbusinessinformation.googleapis.com');
    assert.equal(parsedUrl.pathname, '/v1/accounts/123/locations');
    assert.equal(parsedUrl.searchParams.get('pageToken'), 'page one');
    assert.match(parsedUrl.searchParams.get('readMask'), /name/);
    assert.equal(page.nextPageToken, 'next-page');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
