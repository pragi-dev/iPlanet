// Steps, validation and the submitted body for the Raise Request wizard. The server applies
// the same rules (backend/src/ticketRequests.js).

// Buyback and E-Waste are raised together; older requests may still carry either name on its own.
export const BUYBACK_EWASTE = 'Buyback / E-Waste';
export const LEGACY_BUYBACK_EWASTE = ['Buyback', 'E-Waste'];

// Health camps and buyback / e-waste pickups are on-site visits for a batch of devices, so they
// need a device count and advance notice instead of a device, an issue type and a priority.
export const ON_SITE_LEAD_DAYS = { 'Health Camp': 4, [BUYBACK_EWASTE]: 2 };
export const ON_SITE_CATEGORIES = Object.keys(ON_SITE_LEAD_DAYS);
export const ON_SITE_MAX_DEVICES = 1000;
export const isOnSite = category => ON_SITE_CATEGORIES.includes(category);

export const STEP_LABELS = { details: 'Request details', evidence: 'Evidence', review: 'Review' };
// A Service request identifies its device within Request details. On-site requests are not
// about one device, so they have no device and no photos of an issue (evidence is optional for
// every request type).
export const requestSteps = category => isOnSite(category) ? ['details', 'review'] : ['details', 'evidence', 'review'];
// The last stage, Submit, is reached when the request is created.
export const stepLabels = category => [...requestSteps(category).map(key => STEP_LABELS[key]), 'Submit'];

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export const earliestServiceDate = (category, today) => addDays(today, ON_SITE_LEAD_DAYS[category] || 0);
const validDeviceCount = value => String(value ?? '').trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= ON_SITE_MAX_DEVICES;

// Problems with the Request details step, by field. `today` is India's calendar date (YYYY-MM-DD).
export function detailsErrors(form, today) {
  const errors = {};
  if (!String(form.description || '').trim()) errors.description = 'Describe the issue to continue.';
  if (!isOnSite(form.category) && !form.deviceId) errors.deviceId = 'Select a device to continue.';
  if (isOnSite(form.category)) {
    if (!validDeviceCount(form.deviceCount)) errors.deviceCount = `Enter the number of devices (1 to ${ON_SITE_MAX_DEVICES}).`;
    const earliest = earliestServiceDate(form.category, today);
    if (!(form.preferredServiceDate >= earliest)) errors.preferredServiceDate = `${form.category} requests need ${ON_SITE_LEAD_DAYS[form.category]} days' notice.`;
  }
  return errors;
}

// Whether a step's requirements are met, so the customer can move past it.
export function stepValid(key, form, today) {
  if (key === 'details') return !Object.keys(detailsErrors(form, today)).length;
  if (key === 'review') return requestSteps(form.category).filter(step => step !== 'review').every(step => stepValid(step, form, today));
  return true;
}

export function nextStep(key, category) {
  const steps = requestSteps(category);
  return steps[Math.min(steps.length - 1, steps.indexOf(key) + 1)];
}
export function previousStep(key, category) {
  const steps = requestSteps(category);
  return steps[Math.max(0, steps.indexOf(key) - 1)];
}

// The ticket body. An on-site request carries no device or recommendation link, and is
// recorded at Low priority; a health camp gets its own issue type.
export function requestPayload(form, { serviceFollowUpId } = {}) {
  const { deviceCount, deviceId, ...details } = form;
  if (isOnSite(form.category)) return { ...details, issueType: form.category === 'Health Camp' ? 'Health Camp' : 'Other', priority: 'Low', deviceCount: Number(deviceCount) };
  return { ...details, deviceId, ...(serviceFollowUpId ? { serviceFollowUpId } : {}) };
}
