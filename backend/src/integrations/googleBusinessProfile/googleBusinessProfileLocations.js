function addressText(address = {}) {
  return [address.addressLines?.join(', '), address.locality, address.administrativeArea, address.postalCode].filter(Boolean).join(', ');
}

export function normalizeGoogleBusinessLocation({ account, location }) {
  return {
    googleAccountId: String(account.name || '').replace(/^accounts\//, ''),
    googleLocationId: String(location.name || '').replace(/^locations\//, ''),
    businessName: location.title || '',
    address: addressText(location.storefrontAddress),
    placeId: location.metadata?.placeId || '',
    storeCode: location.storeCode || '',
    status: 'ACTIVE',
    mappingStatus: 'UNMAPPED',
    metadata: { resourceName: location.name, websiteUri: location.websiteUri || '', latlng: location.latlng || null },
  };
}

export function suggestServiceCentre(location, serviceCentres = []) {
  const source = `${location.businessName} ${location.address} ${location.storeCode}`.toLowerCase();
  const matches = serviceCentres.filter(centre => [centre.name, centre.location, centre.city, centre.serviceCentreId].filter(Boolean).some(value => source.includes(String(value).toLowerCase())));
  return matches.length === 1 ? matches[0] : null;
}
