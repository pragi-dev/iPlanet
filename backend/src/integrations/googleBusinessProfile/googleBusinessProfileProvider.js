const GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL = 'https://mybusinessaccountmanagement.googleapis.com';
const GOOGLE_BUSINESS_INFORMATION_BASE_URL = 'https://mybusinessbusinessinformation.googleapis.com';
const GOOGLE_REVIEWS_BASE_URL = 'https://mybusiness.googleapis.com';

async function googleRequest(url, accessToken, description) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    throw new Error(`Unable to ${description}: ${error.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Failed to ${description}: ${response.status} ${errorText}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

export async function listGoogleBusinessAccounts(accessToken) {
  const payload = await googleRequest(`${GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL}/v1/accounts`, accessToken, 'load Google Business accounts');
  return Array.isArray(payload.accounts) ? payload.accounts : [];
}

export async function listGoogleBusinessLocations(accountName, accessToken, pageToken = '') {
  const params = new URLSearchParams({
    readMask: 'name,title,storefrontAddress,websiteUri,metadata',
  });
  if (pageToken) params.set('pageToken', pageToken);
  const payload = await googleRequest(`${GOOGLE_BUSINESS_INFORMATION_BASE_URL}/v1/${accountName}/locations?${params}`, accessToken, 'load Google Business locations');
  return {
    locations: Array.isArray(payload.locations) ? payload.locations : [],
    nextPageToken: payload.nextPageToken || null,
  };
}

export async function getGoogleBusinessReviews(locationName, accessToken, pageToken = '') {
  const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
  const payload = await googleRequest(`${GOOGLE_REVIEWS_BASE_URL}/v4/${locationName}/reviews${query}`, accessToken, 'load Google Business reviews');
  return {
    reviews: Array.isArray(payload.reviews) ? payload.reviews : [],
    nextPageToken: payload.nextPageToken || null,
  };
}

export async function discoverGoogleBusinessLocations(accessToken, accountName = null) {
  const accounts = await listGoogleBusinessAccounts(accessToken);
  const targetAccounts = accountName ? accounts.filter(account => account.name === accountName || account.accountName === accountName) : accounts;

  const discovered = [];
  for (const account of targetAccounts) {
    let nextPageToken = '';
    do {
      const page = await listGoogleBusinessLocations(account.name, accessToken, nextPageToken);
      discovered.push(...page.locations.map(location => ({
        ...location,
        accountName: account.name,
        accountDisplayName: account.displayName || account.accountName || account.name,
      })));
      nextPageToken = page.nextPageToken || '';
    } while (nextPageToken);
  }

  return discovered;
}
