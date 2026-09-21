import test from 'node:test';
import assert from 'node:assert/strict';
import { listGoogleBusinessAccounts, listGoogleBusinessLocations } from './googleBusinessProfileProvider.js';

test('listGoogleBusinessAccounts calls the Account Management API', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const payload = requests.length === 1
      ? { accounts: [{ name: 'accounts/123', accountName: 'Demo account' }], nextPageToken: 'next-page' }
      : { accounts: [{ name: 'accounts/456', accountName: 'Second account' }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };

  try {
    const accounts = await listGoogleBusinessAccounts('access-token');
    assert.deepEqual(accounts, [
      { name: 'accounts/123', accountName: 'Demo account' },
      { name: 'accounts/456', accountName: 'Second account' },
    ]);
    assert.equal(new URL(requests[0].url).origin, 'https://mybusinessaccountmanagement.googleapis.com');
    assert.equal(new URL(requests[0].url).pathname, '/v1/accounts');
    assert.equal(new URL(requests[0].url).searchParams.get('pageSize'), '100');
    assert.equal(new URL(requests[1].url).searchParams.get('pageToken'), 'next-page');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer access-token');
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
