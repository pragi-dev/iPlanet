const GOOGLE_BUSINESS_BASE_URL = 'https://businessprofileperformance.googleapis.com';

export async function listGoogleBusinessAccounts(accessToken) {
  const response = await fetch(`${GOOGLE_BUSINESS_BASE_URL}/v1/accounts`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to load Google Business accounts: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  return Array.isArray(payload.accounts) ? payload.accounts : [];
}

export async function listGoogleBusinessLocations(accountName, accessToken, pageToken = '') {
  const url = `${GOOGLE_BUSINESS_BASE_URL}/v1/${accountName}/locations${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to load Google Business locations: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  return {
    locations: Array.isArray(payload.locations) ? payload.locations : [],
    nextPageToken: payload.nextPageToken || null,
  };
}

export async function getGoogleBusinessReviews(locationName, accessToken, pageToken = '') {
  const url = `${GOOGLE_BUSINESS_BASE_URL}/v1/${locationName}/reviews${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to load Google Business reviews: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
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
