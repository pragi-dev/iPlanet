// Rules for a request raised by a corporate admin, matching the Raise Request wizard
// (frontend/src/corporate/requestFlow.js).

// Health camps and buyback / e-waste pickups are on-site visits for a batch of devices:
// they need a device count and advance notice to plan, and are not about one device.
export const ON_SITE_LEAD_DAYS = { 'Health Camp': 4, 'Buyback / E-Waste': 2 };
export const ON_SITE_CATEGORIES = Object.keys(ON_SITE_LEAD_DAYS);
export const ON_SITE_MAX_DEVICES = 1000;
export const isOnSiteRequest = category => ON_SITE_CATEGORIES.includes(category);

const addDaysIso = (iso, days) => { const date = new Date(`${iso}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };

// The first date an on-site visit can be booked for. `today` is India's calendar date (YYYY-MM-DD).
export const onSiteEarliestDate = (category, today) => addDaysIso(today, ON_SITE_LEAD_DAYS[category]);

// `today` is India's calendar date (YYYY-MM-DD).
export function onSiteRequestError(body, today) {
  if (!isOnSiteRequest(body.category)) return null;
  const count = Number(body.deviceCount);
  if (String(body.deviceCount ?? '').trim() === '' || !Number.isInteger(count) || count < 1 || count > ON_SITE_MAX_DEVICES) return `Enter the number of devices (1 to ${ON_SITE_MAX_DEVICES}).`;
  const earliest = onSiteEarliestDate(body.category, today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.preferredServiceDate || '') || body.preferredServiceDate < earliest) return `Choose a ${body.category} date on or after ${earliest}.`;
  return null;
}

// What a new request needs before it is created: { error } to reject it, otherwise
// { deviceId } — the device to look up in the admin's own organization, or null for an
// on-site request, which is never linked to a device or a service recommendation.
export function ticketRequestCheck(body = {}, today) {
  if (isOnSiteRequest(body.category)) {
    const error = onSiteRequestError(body, today);
    if (error) return { error };
    if (body.serviceFollowUpId) return { error: 'A service recommendation can only be raised as a Service request.' };
    return { deviceId: null };
  }
  // Checked as an ObjectId first: a missing ID would otherwise match any of the company's devices.
  if (!/^[a-f0-9]{24}$/i.test(String(body.deviceId || ''))) return { error: 'Valid company device selection is required' };
  return { deviceId: String(body.deviceId) };
}
