// Where a device record came from. The backend path that creates the record sets it once;
// it is never read from request input and cannot be changed afterwards (the field is
// immutable on the model). Records created before the field existed have no value.
export const DEVICE_SOURCES = {
  IPLANET: 'IPLANET', // enrolled by iPlanet Service from the iPlanet device master
  MANUAL: 'MANUAL', // Add Device → Add Manually by a corporate admin
  EXCEL_IMPORT: 'EXCEL_IMPORT', // Add Device → Import Excel by a corporate admin
};

// Dashboard categories: devices a corporate admin added manually are Other Devices; every
// other device (iPlanet enrolments, Excel imports and records without an origin) is an
// iPlanet device.
export const deviceCategory = source => source === DEVICE_SOURCES.MANUAL ? 'other' : 'iplanet';

// Device counts by category for the devices matching `match` (already scoped to the caller's
// organization), counted by MongoDB rather than by loading the devices.
// total always equals iplanet + other.
export async function deviceSourceCounts(Device, match = {}) {
  const rows = await Device.aggregate([{ $match: match }, { $group: { _id: '$deviceSource', count: { $sum: 1 } } }]);
  const counts = { total: 0, iplanet: 0, other: 0 };
  for (const { _id: source, count } of rows) {
    counts.total += count;
    counts[deviceCategory(source)] += count;
  }
  return counts;
}
