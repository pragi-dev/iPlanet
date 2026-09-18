import { GoogleBusinessProfileError, googleRequest, refreshGoogleBusinessAccessToken } from './googleBusinessProfileAuth.js';

const ACCOUNT_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const LOCATION_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const REVIEW_API = 'https://mybusiness.googleapis.com/v4';

export class GoogleBusinessProfileProvider {
  constructor({ refreshToken, environment = process.env, fetchImpl = fetch } = {}) {
    this.refreshToken = refreshToken;
    this.environment = environment;
    this.fetchImpl = fetchImpl;
  }

  async accessToken() {
    if (!this.token || !this.tokenExpiresAt || this.tokenExpiresAt <= Date.now() + 60000) {
      const token = await refreshGoogleBusinessAccessToken(this.refreshToken, this.environment, this.fetchImpl);
      this.token = token.access_token;
      this.tokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
    }
    return this.token;
  }

  async get(path, params = {}) {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return googleRequest(`${path}${query.toString() ? `?${query}` : ''}`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } }, this.fetchImpl);
  }

  async listAccounts() {
    const accounts = [];
    let pageToken = '';
    do {
      const result = await this.get(`${ACCOUNT_API}/accounts`, { pageSize: 100, pageToken });
      accounts.push(...(result.accounts || []));
      pageToken = result.nextPageToken || '';
    } while (pageToken);
    return accounts;
  }

  async listLocations(accountName) {
    const locations = [];
    let pageToken = '';
    do {
      const result = await this.get(`${LOCATION_API}/${accountName}/locations`, { readMask: 'name,title,storeCode,metadata,storefrontAddress,latlng,websiteUri', pageSize: 100, pageToken });
      locations.push(...(result.locations || []));
      pageToken = result.nextPageToken || '';
    } while (pageToken);
    return locations;
  }

  async discoverLocations() {
    const accounts = await this.listAccounts();
    const discovered = [];
    for (const account of accounts) for (const location of await this.listLocations(account.name)) discovered.push({ account, location });
    return discovered;
  }

  async getAllReviews(accountId, locationId) {
    const reviews = [];
    let pageToken = '';
    do {
      const result = await this.get(`${REVIEW_API}/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews`, { pageSize: 50, pageToken, orderBy: 'updateTime desc' });
      reviews.push(...(result.reviews || []));
      pageToken = result.nextPageToken || '';
    } while (pageToken);
    return reviews;
  }

  async getReview(accountId, locationId, reviewId) {
    return this.get(`${REVIEW_API}/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews/${encodeURIComponent(reviewId)}`);
  }
}

export function createGoogleBusinessProfileProvider(options = {}) {
  return new GoogleBusinessProfileProvider(options);
}
