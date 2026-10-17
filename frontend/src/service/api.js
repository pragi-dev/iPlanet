const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const API = API_BASE ? `${API_BASE.replace(/\/api$/, '')}/api` : '/api';
const API_ORIGIN = API_BASE ? API_BASE.replace(/\/api$/, '') : '';
export const mediaUrl = path => {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  const normalized = String(path).replace(/^\/+/, '');
  return `${API_ORIGIN || ''}/${normalized}`;
};
const token = () => localStorage.getItem('iplanet_token') || localStorage.getItem('iplanet_service_token');
import { cachedGet, clearRequestCache, isCacheablePath } from '../ui/requestCache';
import { endExpiredSession, isExpiredSessionResponse } from '../ui/session';

function request(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (method !== 'GET') { clearRequestCache(); return send(path, options); }
  return isCacheablePath(path) ? cachedGet(`${token()}|${path}`, () => send(path, options)) : send(path, options);
}
async function send(path, options = {}) {
  const response = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(options.headers || {}) } });
  if (!response.ok) {
    if (isExpiredSessionResponse(response.status, path, Boolean(token()))) endExpiredSession();
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || `Request failed (${response.status})`);
    error.status = response.status;
    // Google Business endpoints add a safe, categorised error (e.g. access_pending).
    if (body.error && typeof body.error === 'object') error.google = body.error;
    throw error;
  }
  return response.json();
}
export async function login(email, password) { return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); }
export async function getServiceDashboard() { return request('/iplanet/dashboard'); }
export async function getServiceActivity({ limit = 8, since } = {}) { const params = new URLSearchParams({ limit: String(limit), ...(since ? { since: new Date(since).toISOString() } : {}) }); return request(`/iplanet/activity?${params}`); }
export async function getServiceTickets(filters = {}) { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value && value !== 'All')); return request(`/iplanet/tickets${params.toString() ? `?${params}` : ''}`); }
export async function getServiceTicket(id) { return request(`/iplanet/tickets/${id}`); }
export async function getServiceReviews(filters = {}) { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value && value !== 'All')); return request(`/service/reviews${params.toString() ? `?${params}` : ''}`); }
export async function getServiceReview(id) { return request(`/service/reviews/${id}`); }
export async function getEngineers() { return request('/iplanet/engineers'); }
export async function getCompanies() { return request('/iplanet/companies'); }
export async function createCompany(payload) { return request('/iplanet/companies', { method: 'POST', body: JSON.stringify(payload) }); }
export async function getServiceCentres() { return request('/iplanet/service-centres'); }
// Google Business Profile (all calls go through the backend; no Google credentials in the browser)
export async function getGoogleBusinessStatus() { return request('/google-business/status'); }
export async function startGoogleBusinessAuth({ reconnect = false } = {}) { return request(`/google-business/auth${reconnect ? '?reconnect=true' : ''}`); }
export async function checkGoogleConnection() { return request('/google-business/check', { method: 'POST', body: JSON.stringify({}) }); }
export async function disconnectGoogleBusiness() { return request('/google-business/connection', { method: 'DELETE' }); }
export async function getGoogleLocations({ refresh = false } = {}) { return request(`/google-business/locations${refresh ? '?refresh=true' : ''}`); }
export async function getGoogleMappings() { return request('/google-business/mappings'); }
export async function mapGoogleLocation(payload) { return request('/google-business/locations/map', { method: 'POST', body: JSON.stringify(payload) }); }
export async function unmapGoogleLocation(mappingId) { return request(`/google-business/locations/map/${mappingId}`, { method: 'DELETE' }); }
export async function getGoogleReviews({ mappingId, pageToken } = {}) { const params = new URLSearchParams(Object.entries({ mappingId, pageToken }).filter(([, value]) => value)); return request(`/google-business/reviews${params.toString() ? `?${params}` : ''}`); }
export async function syncGoogleLocation(mappingId) { return request(`/google-business/locations/${mappingId}/sync`, { method: 'POST', body: JSON.stringify({}) }); }
export async function saveGoogleReviewReply(mappingId, reviewId, comment) { return request(`/google-business/locations/${mappingId}/reviews/${encodeURIComponent(reviewId)}/reply`, { method: 'PUT', body: JSON.stringify({ comment, confirmed: true }) }); }
export async function deleteGoogleReviewReply(mappingId, reviewId) { return request(`/google-business/locations/${mappingId}/reviews/${encodeURIComponent(reviewId)}/reply`, { method: 'DELETE', body: JSON.stringify({ confirmed: true }) }); }
export async function getGoogleNotificationSetting(accountName) { return request(`/google-business/notifications?accountName=${encodeURIComponent(accountName)}`); }
export async function setGoogleNotifications(accountName, enabled) { return request('/google-business/notifications', { method: 'PUT', body: JSON.stringify({ accountName, enabled }) }); }
export async function createServiceCentre(payload) { return request('/iplanet/service-centres', { method: 'POST', body: JSON.stringify(payload) }); }
export async function assignEngineer(ticketId, engineerId) { return request(`/iplanet/tickets/${ticketId}/assign`, { method: 'POST', body: JSON.stringify({ engineerId }) }); }
export async function serviceAction(ticketId, action, payload = {}) { const path = action === 'updates' ? 'update' : action; return request(`/iplanet/tickets/${ticketId}/${path}`, { method: 'POST', body: JSON.stringify(payload) }); }
export async function getServiceReports() { return request('/iplanet/reports'); }
export async function getDeviceMaster(serial) { return request(`/iplanet/device-master/${encodeURIComponent(serial)}`); }
export async function getDeviceMasters() { return request('/iplanet/device-master'); }
export async function enrollDevice(payload) { return request('/iplanet/devices/enroll', { method: 'POST', body: JSON.stringify(payload) }); }
export async function getServiceNotifications() { return request('/iplanet/notifications'); }
export async function getServiceNotificationUnreadCount() { return request('/iplanet/notifications/unread-count'); }
export async function markServiceNotificationRead(id) { return request(`/iplanet/notifications/${id}/read`, { method: 'PATCH', body: JSON.stringify({}) }); }
export async function markAllServiceNotificationsRead() { return request('/iplanet/notifications/read-all', { method: 'PATCH', body: JSON.stringify({}) }); }
export async function getEscalationMatrix() { return request('/escalation-matrix'); }
export async function getEscalationRules() { return request('/iplanet/escalation-rules'); }
export async function createEscalationRule(payload) { return request('/iplanet/escalation-rules', { method: 'POST', body: JSON.stringify(payload) }); }
export async function updateEscalationRule(id, payload) { return request(`/iplanet/escalation-rules/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }); }
export async function getTicketCalls(ticketId) { return request(`/iplanet/tickets/${ticketId}/calls`); }
export async function saveTicketCall(ticketId, payload) { return request(`/iplanet/tickets/${ticketId}/calls`, { method: 'POST', body: JSON.stringify(payload) }); }
export async function getTicketAITroubleshooting(ticketId) { return request(`/iplanet/tickets/${ticketId}/ai-support`); }
export async function startTicketAITroubleshooting(ticketId, payload) { return request(`/iplanet/tickets/${ticketId}/ai-support`, { method: 'POST', body: JSON.stringify(payload) }); }
export async function getCoverage() { return request('/coverage'); }
// Proactive device service
const query = filters => { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value && value !== 'All')); return params.toString() ? `?${params}` : ''; };
export async function getProactiveFollowUps(filters = {}) { return request(`/iplanet/proactive-service/followups${query(filters)}`); }
export async function getProactiveFollowUp(id) { return request(`/iplanet/proactive-service/followups/${id}`); }
export async function proactiveFollowUpAction(id, action, payload) { return request(`/iplanet/proactive-service/followups/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload) }); }
export async function updateDeviceServicePlan(deviceId, payload) { return request(`/iplanet/devices/${deviceId}/service-plan`, { method: 'PATCH', body: JSON.stringify(payload) }); }
