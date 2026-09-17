export async function findGoogleMappedServiceCentre({ ServiceCentre, locationId, locationName, accountId, placeId, googleBusinessProfile } = {}) {
  if (!ServiceCentre) return null;
  const query = {
    $or: [
      { 'googleBusinessProfile.locationId': locationId },
      { 'googleBusinessProfile.placeId': placeId },
      { 'googleBusinessProfile.businessName': locationName },
      { 'googleBusinessProfile.locationName': locationName },
      { name: locationName },
    ]
  };

  if (googleBusinessProfile?.accountId) {
    query.$or.push({ 'googleBusinessProfile.accountId': googleBusinessProfile.accountId });
  }

  return ServiceCentre.findOne(query).lean();
}

export function normalizeGoogleLocationPayload(input = {}) {
  return {
    accountId: input.accountId || input.googleAccountId || '',
    locationId: input.locationId || input.googleLocationId || '',
    locationName: input.locationName || input.name || '',
    placeId: input.placeId || input.googlePlaceId || '',
    connected: Boolean(input.connected ?? true),
  };
}
