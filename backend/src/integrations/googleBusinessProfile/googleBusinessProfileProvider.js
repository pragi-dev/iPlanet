import { GoogleBusinessApiError, GOOGLE_ERROR_CATEGORIES, classifyGoogleApiResponse } from './googleBusinessProfileErrors.js';

// Official Business Profile API hosts:
// - Account Management API v1: accounts
// - Business Information API v1: locations
// - Google My Business API v4: reviews and review replies (still served from v4)
// - Notifications API v1: account notification settings (Pub/Sub topic)
const GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL = 'https://mybusinessaccountmanagement.googleapis.com';
const GOOGLE_BUSINESS_INFORMATION_BASE_URL = 'https://mybusinessbusinessinformation.googleapis.com';
const GOOGLE_REVIEWS_BASE_URL = 'https://mybusiness.googleapis.com';
const GOOGLE_NOTIFICATIONS_BASE_URL = 'https://mybusinessnotifications.googleapis.com';

export const GOOGLE_REVIEWS_MAX_PAGE_SIZE = 50;
export const GOOGLE_REVIEW_NOTIFICATION_TYPES = ['NEW_REVIEW', 'UPDATED_REVIEW'];

const ACCOUNT_PATTERN = /^accounts\/[A-Za-z0-9_-]+$/;
const LOCATION_PATTERN = /^locations\/[A-Za-z0-9_-]+$/;
const ACCOUNT_LOCATION_PATTERN = /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+$/;
const REVIEW_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Retries apply only to genuinely transient failures (rate limits with a
// non-zero quota, 5xx, network errors). Tests replace `sleep`.
const retryConfig = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000, maxRetryAfterSeconds: 30, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export function configureGoogleBusinessRetries(overrides = {}) { Object.assign(retryConfig, overrides); return { ...retryConfig }; }

export const isGoogleAccountName = value => ACCOUNT_PATTERN.test(String(value || ''));
export const isGoogleLocationName = value => LOCATION_PATTERN.test(String(value || ''));
export const isGoogleReviewId = value => REVIEW_ID_PATTERN.test(String(value || ''));

// v4 review endpoints address a location as accounts/{a}/locations/{l}, while
// Business Information returns locations as locations/{l}.
export function googleReviewsLocationPath(accountName, locationName) {
  if (ACCOUNT_LOCATION_PATTERN.test(String(locationName || ''))) return locationName;
  if (!isGoogleAccountName(accountName) || !isGoogleLocationName(locationName)) {
    throw new GoogleBusinessApiError(GOOGLE_ERROR_CATEGORIES.INVALID_REQUEST, { message: 'The Google location is not linked to a Google account.' });
  }
  return `${accountName}/${locationName}`;
}

async function googleRequest(url, accessToken, { method = 'GET', body } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      response = null;
    }

    if (response?.ok) {
      if (response.status === 204) return {};
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }

    const error = response
      ? classifyGoogleApiResponse(response.status, await response.json().catch(() => null), response.headers)
      : new GoogleBusinessApiError(GOOGLE_ERROR_CATEGORIES.TRANSIENT, { message: 'Unable to reach Google Business Profile.' });

    if (!error.retryable || attempt >= retryConfig.maxAttempts) throw error;
    if (error.retryAfterSeconds !== null && error.retryAfterSeconds > retryConfig.maxRetryAfterSeconds) throw error;
    const backoff = Math.min(retryConfig.maxDelayMs, retryConfig.baseDelayMs * 2 ** (attempt - 1));
    await retryConfig.sleep(error.retryAfterSeconds !== null ? error.retryAfterSeconds * 1000 : backoff);
  }
}

export async function listGoogleBusinessAccounts(accessToken) {
  const accounts = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const payload = await googleRequest(`${GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL}/v1/accounts?${params}`, accessToken);
    if (Array.isArray(payload.accounts)) accounts.push(...payload.accounts);
    pageToken = payload.nextPageToken || '';
  } while (pageToken);

  return accounts;
}

export function normalizeGoogleBusinessAccount(account) {
  if (!account || typeof account !== 'object') return null;
  const accountName = typeof account.name === 'string' ? account.name : '';
  const accountId = accountName.startsWith('accounts/') ? accountName.slice('accounts/'.length) : accountName;
  return {
    accountId: accountId || null,
    accountName: accountName || null,
    accountDisplayName: typeof account.accountName === 'string' && account.accountName ? account.accountName : null,
    type: typeof account.type === 'string' ? account.type : null,
    role: typeof account.role === 'string' ? account.role : null,
    verificationState: typeof account.verificationState === 'string' ? account.verificationState : null,
  };
}

export async function listGoogleBusinessLocations(accountName, accessToken, pageToken = '') {
  const params = new URLSearchParams({
    readMask: 'name,title,storefrontAddress,websiteUri,metadata',
    pageSize: '100',
  });
  if (pageToken) params.set('pageToken', pageToken);
  const payload = await googleRequest(`${GOOGLE_BUSINESS_INFORMATION_BASE_URL}/v1/${accountName}/locations?${params}`, accessToken);
  return {
    locations: Array.isArray(payload.locations) ? payload.locations : [],
    nextPageToken: payload.nextPageToken || null,
  };
}

// Only the fields the portal needs; address lines are joined for display.
export function normalizeGoogleBusinessLocation(location, account) {
  if (!location || typeof location.name !== 'string') return null;
  const address = location.storefrontAddress || {};
  const addressText = [...(Array.isArray(address.addressLines) ? address.addressLines : []), address.locality, address.administrativeArea, address.postalCode].filter(Boolean).join(', ');
  return {
    locationName: location.name,
    title: typeof location.title === 'string' ? location.title : null,
    address: addressText || null,
    websiteUri: typeof location.websiteUri === 'string' ? location.websiteUri : null,
    mapsUri: typeof location.metadata?.mapsUri === 'string' ? location.metadata.mapsUri : null,
    newReviewUri: typeof location.metadata?.newReviewUri === 'string' ? location.metadata.newReviewUri : null,
    accountName: account?.name || null,
    accountDisplayName: account?.accountName || null,
  };
}

export async function discoverGoogleBusinessLocations(accessToken, accountName = null) {
  const accounts = await listGoogleBusinessAccounts(accessToken);
  const targetAccounts = accountName ? accounts.filter(account => account.name === accountName) : accounts;

  const discovered = [];
  for (const account of targetAccounts) {
    let nextPageToken = '';
    do {
      const page = await listGoogleBusinessLocations(account.name, accessToken, nextPageToken);
      discovered.push(...page.locations.map(location => normalizeGoogleBusinessLocation(location, account)).filter(Boolean));
      nextPageToken = page.nextPageToken || '';
    } while (nextPageToken);
  }

  return { accounts, locations: discovered };
}

// GET accounts/{a}/locations/{l}/reviews — returns one page plus the
// location-level averageRating and totalReviewCount Google reports.
export async function getGoogleBusinessReviews(locationPath, accessToken, pageToken = '', { pageSize = GOOGLE_REVIEWS_MAX_PAGE_SIZE, orderBy = 'updateTime desc' } = {}) {
  const params = new URLSearchParams({ pageSize: String(Math.min(GOOGLE_REVIEWS_MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || GOOGLE_REVIEWS_MAX_PAGE_SIZE))) });
  if (orderBy) params.set('orderBy', orderBy);
  if (pageToken) params.set('pageToken', pageToken);
  const payload = await googleRequest(`${GOOGLE_REVIEWS_BASE_URL}/v4/${locationPath}/reviews?${params}`, accessToken);
  return {
    reviews: Array.isArray(payload.reviews) ? payload.reviews : [],
    nextPageToken: payload.nextPageToken || null,
    averageRating: typeof payload.averageRating === 'number' ? payload.averageRating : null,
    totalReviewCount: typeof payload.totalReviewCount === 'number' ? payload.totalReviewCount : null,
  };
}

export async function getGoogleBusinessReview(locationPath, reviewId, accessToken) {
  if (!isGoogleReviewId(reviewId)) throw new GoogleBusinessApiError(GOOGLE_ERROR_CATEGORIES.INVALID_REQUEST, { message: 'Invalid Google review ID.' });
  return googleRequest(`${GOOGLE_REVIEWS_BASE_URL}/v4/${locationPath}/reviews/${reviewId}`, accessToken);
}

// PUT accounts/{a}/locations/{l}/reviews/{r}/reply with a ReviewReply body ({ comment }).
export async function updateGoogleBusinessReviewReply(locationPath, reviewId, comment, accessToken) {
  if (!isGoogleReviewId(reviewId)) throw new GoogleBusinessApiError(GOOGLE_ERROR_CATEGORIES.INVALID_REQUEST, { message: 'Invalid Google review ID.' });
  return googleRequest(`${GOOGLE_REVIEWS_BASE_URL}/v4/${locationPath}/reviews/${reviewId}/reply`, accessToken, { method: 'PUT', body: { comment } });
}

export async function deleteGoogleBusinessReviewReply(locationPath, reviewId, accessToken) {
  if (!isGoogleReviewId(reviewId)) throw new GoogleBusinessApiError(GOOGLE_ERROR_CATEGORIES.INVALID_REQUEST, { message: 'Invalid Google review ID.' });
  await googleRequest(`${GOOGLE_REVIEWS_BASE_URL}/v4/${locationPath}/reviews/${reviewId}/reply`, accessToken, { method: 'DELETE' });
  return true;
}

// GET accounts/{a}/notificationSetting
export async function getGoogleBusinessNotificationSetting(accountName, accessToken) {
  if (!isGoogleAccountName(accountName)) throw new GoogleBusinessApiError(GOOGLE_ERROR_CATEGORIES.INVALID_REQUEST, { message: 'Invalid Google account.' });
  return googleRequest(`${GOOGLE_NOTIFICATIONS_BASE_URL}/v1/${accountName}/notificationSetting`, accessToken);
}

// PATCH accounts/{a}/notificationSetting?updateMask=pubsubTopic,notificationTypes
// An empty topic with no types turns notifications off.
export async function updateGoogleBusinessNotificationSetting(accountName, { pubsubTopic, notificationTypes }, accessToken) {
  if (!isGoogleAccountName(accountName)) throw new GoogleBusinessApiError(GOOGLE_ERROR_CATEGORIES.INVALID_REQUEST, { message: 'Invalid Google account.' });
  const params = new URLSearchParams({ updateMask: 'pubsubTopic,notificationTypes' });
  return googleRequest(`${GOOGLE_NOTIFICATIONS_BASE_URL}/v1/${accountName}/notificationSetting?${params}`, accessToken, {
    method: 'PATCH',
    body: { name: `${accountName}/notificationSetting`, pubsubTopic: pubsubTopic || '', notificationTypes: notificationTypes || [] },
  });
}
