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
async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(options.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return response.json();
}
export async function login(email, password) { return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); }
export async function getServiceDashboard() { return request('/iplanet/dashboard'); }
export async function getServiceTickets(filters = {}) { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value && value !== 'All')); return request(`/iplanet/tickets${params.toString() ? `?${params}` : ''}`); }
export async function getServiceTicket(id) { return request(`/iplanet/tickets/${id}`); }
export async function getServiceReviews(filters = {}) { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value && value !== 'All')); return request(`/service/reviews${params.toString() ? `?${params}` : ''}`); }
export async function getServiceReview(id) { return request(`/service/reviews/${id}`); }
export async function getEngineers() { return request('/iplanet/engineers'); }
export async function getCompanies() { return request('/iplanet/companies'); }
export async function createCompany(payload) { return request('/iplanet/companies', { method: 'POST', body: JSON.stringify(payload) }); }
export async function getServiceCentres() { return request('/iplanet/service-centres'); }
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
