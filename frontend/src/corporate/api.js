const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const API = API_BASE ? `${API_BASE.replace(/\/api$/, '')}/api` : '/api';
const API_ORIGIN = API_BASE ? API_BASE.replace(/\/api$/, '') : '';
export const mediaUrl = path => {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  const normalized = String(path).replace(/^\/+/, '');
  return `${API_ORIGIN || ''}/${normalized}`;
};
const getToken = () => localStorage.getItem('iplanet_token');
async function request(path, options = {}) { const response = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...(options.headers || {}) } }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || `Request failed (${response.status})`); } return response.json(); }
export async function login(email, password) { return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); }
export async function getDevices(search = '') { return request(`/devices${search ? `?search=${encodeURIComponent(search)}` : ''}`); }
export async function getDevice(id) { return request(`/devices/${id}`); }
export async function getTickets() { return request('/tickets'); }
export async function getTicket(id) { return request(`/tickets/${id}`); }
export async function submitReview(payload) { return request('/reviews', { method: 'POST', body: JSON.stringify(payload) }); }
export async function getMyReviews() { return request('/reviews/my'); }
export async function createTicket(payload) { return request('/tickets', { method: 'POST', body: JSON.stringify(payload) }); }
export async function uploadImages(ticketId, files) { if (!files.length || String(ticketId).startsWith('ticket-')) return; const body = new FormData(); files.forEach(file => body.append('images', file)); const response = await fetch(`${API}/tickets/${ticketId}/images`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body }); if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.message || `Image upload failed (${response.status})`); } }
export async function uploadAnnotatedImages(ticketId, files) { if (!files.length || String(ticketId).startsWith('ticket-')) return; const body = new FormData(); files.forEach(file => body.append('images', file)); const response = await fetch(`${API}/tickets/${ticketId}/annotated-images`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body }); if (!response.ok) throw new Error('Annotated image upload failed'); return response.json(); }
export async function getDashboard() { const [stats, volume, locations] = await Promise.all([request('/dashboard/stats'), request('/dashboard/ticket-volume'), request('/dashboard/location-distribution')]); return { stats, volume, locations }; }
export async function getProfile() { return request('/profile'); }
export async function getNotifications() { return request('/corporate/notifications'); }
export async function getNotificationUnreadCount() { return request('/corporate/notifications/unread-count'); }
export async function markNotificationRead(id) { return request(`/corporate/notifications/${id}/read`, { method: 'PATCH', body: JSON.stringify({}) }); }
export async function markAllNotificationsRead() { return request('/corporate/notifications/read-all', { method: 'PATCH', body: JSON.stringify({}) }); }
export async function assignDeviceToEmployee(id, payload) { return request(`/corporate/devices/${id}/assign`, { method: 'PATCH', body: JSON.stringify(payload) }); }
export async function getTicketCalls(ticketId) { return request(`/tickets/${ticketId}/calls`); }
export async function saveTicketCall(ticketId, payload) { return request(`/tickets/${ticketId}/calls`, { method: 'POST', body: JSON.stringify(payload) }); }
export async function getTicketAITroubleshooting(ticketId) { return request(`/tickets/${ticketId}/ai-support`); }
export async function startTicketAITroubleshooting(ticketId, payload) { return request(`/tickets/${ticketId}/ai-support`, { method: 'POST', body: JSON.stringify(payload) }); }
export async function sendAiSupportMessage(ticketId, payload) { return request('/ai/support/chat', { method: 'POST', body: JSON.stringify({ ...payload, ticketId }) }); }
export async function getAiPreparedRequest(conversationId) { return request(`/ai/support/request-data/${encodeURIComponent(conversationId)}`); }
export async function getCoverage() { return request('/coverage'); }
