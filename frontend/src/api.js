const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const API = API_BASE ? `${API_BASE.replace(/\/api$/, '')}/api` : '/api';
const API_ORIGIN = API_BASE ? API_BASE.replace(/\/api$/, '') : '';
const getToken = () => localStorage.getItem('iplanet_token');

export const mediaUrl = path => {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  const normalized = String(path).replace(/^\/+/, '');
  return `${API_ORIGIN || ''}/${normalized}`;
};

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }

  return response.json();
}

export async function login(email, password) {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export async function getDevices(search = '') {
  return request(`/devices${search ? `?search=${encodeURIComponent(search)}` : ''}`);
}

export async function getDevice(id) {
  return request(`/devices/${id}`);
}

export async function getTickets() {
  return request('/tickets');
}

export async function getTicket(id) {
  return request(`/tickets/${id}`);
}

export async function createTicket(payload) {
  return request('/tickets', { method: 'POST', body: JSON.stringify(payload) });
}

export async function uploadImages(ticketId, files) {
  if (!files.length || String(ticketId).startsWith('ticket-')) return;
  const body = new FormData();
  files.forEach(file => body.append('images', file));
  await fetch(`${API}/tickets/${ticketId}/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body,
  });
}

export async function getDashboard() {
  const [stats, volume, locations] = await Promise.all([
    request('/dashboard/stats'),
    request('/dashboard/ticket-volume'),
    request('/dashboard/location-distribution'),
  ]);
  return { stats, volume, locations };
}

export async function getProfile() {
  return request('/profile');
}

export async function getUnassignedDevices() {
  const devices = await request('/devices');
  return devices.filter(device => device.deviceAllocationStatus === 'Unassigned');
}

export async function assignDeviceToEmployee(id, payload) {
  return request(`/corporate/devices/${id}/assign`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function getServiceTickets(filters = {}) {
  const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value && value !== 'All'));
  return request(`/service/tickets${params.toString() ? `?${params}` : ''}`);
}

export async function getServiceTicket(id) {
  return request(`/service/tickets/${id}`);
}

export async function getEngineers() {
  return request('/service/engineers');
}

export async function assignEngineer(ticketId, engineerId) {
  return request(`/service/tickets/${ticketId}/assign`, { method: 'POST', body: JSON.stringify({ engineerId }) });
}

export async function serviceAction(ticketId, action, payload = {}) {
  return request(`/service/tickets/${ticketId}/${action}`, { method: 'POST', body: JSON.stringify(payload) });
}

export async function addServiceUpdate(ticketId, payload) {
  return serviceAction(ticketId, 'updates', payload);
}

export async function getServiceDashboard() {
  const [stats, volume, locations] = await Promise.all([
    request('/service/dashboard/stats'),
    request('/service/dashboard/ticket-volume'),
    request('/service/dashboard/location-distribution'),
  ]);
  return { stats, volume, locations };
}

export async function getServiceReports() {
  return request('/service/reports');
}

