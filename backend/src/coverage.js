// Warranty and coverage of device records, shared by the iPlanet Service portal
// (/api/coverage) and B2C escalations (/api/b2c/coverage and the ticket's device).
// A device is covered while its warranty or AMC is active or expiring soon.
const ACTIVE = ['Active', 'Expiring Soon'];
export const COVERED_ENTITLEMENTS = ['Repair', 'Parts Replacement', 'Remote Support'];

export const isCovered = device => ACTIVE.includes(device.warrantyStatus) || ACTIVE.includes(device.amcStatus);

export function withCoverage(device) {
  const covered = isCovered(device);
  return { ...device, coverageStatus: covered ? 'Covered' : 'Not Covered', entitlements: covered ? COVERED_ENTITLEMENTS : [] };
}

// The coverage page: each device with its coverage, and the summary counts.
export function coverageReport(devices, sources) {
  const covered = devices.map(withCoverage);
  const count = test => covered.filter(test).length;
  return {
    summary: {
      total: covered.length,
      warrantyActive: count(device => device.warrantyStatus === 'Active'),
      amcActive: count(device => device.amcStatus === 'Active'),
      expiringSoon: count(device => device.warrantyStatus === 'Expiring Soon' || device.amcStatus === 'Expiring Soon'),
      expired: count(device => device.warrantyStatus === 'Expired' || device.amcStatus === 'Expired'),
      sources,
    },
    devices: covered,
  };
}
