import { apiRequest as request, downloadProtectedFile, publicB2CRequest } from '../service/api';

// B2C escalation API. Every call goes through the backend; email and CRM
// credentials never reach the browser.
const query = filters => {
  const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== 'All'));
  return params.toString() ? `?${params}` : '';
};
const post = (path, body = {}) => request(path, { method: 'POST', body: JSON.stringify(body) });

export const getB2CMe = () => request('/b2c/me');
export const getB2CDashboard = () => request('/b2c/dashboard');
export const getB2CStaff = () => request('/b2c/staff');
export const getB2CTickets = (filters = {}) => request(`/b2c/tickets${query(filters)}`);
export const getB2CTicket = id => request(`/b2c/tickets/${id}`);
export const b2cTicketAction = (id, action, payload) => post(`/b2c/tickets/${id}/actions/${action}`, payload);
export const downloadB2CAttachment = (ticketId, key, filename) => downloadProtectedFile(`/b2c/tickets/${ticketId}/attachments/${key}`, filename);
export const getB2CReports = (filters = {}) => request(`/b2c/reports${query(filters)}`);
export const getB2CSettings = () => request('/b2c/settings');
export const saveB2CSettings = payload => request('/b2c/settings', { method: 'PUT', body: JSON.stringify(payload) });
export const getB2CHealth = () => request('/b2c/integrations/health');
export const runB2CCycle = () => post('/b2c/integrations/run');
export const verifyB2CImap = () => post('/b2c/integrations/imap/verify');
export const getB2CInbound = (filters = {}) => request(`/b2c/inbound${query(filters)}`);
export const retryB2CInbound = id => post(`/b2c/inbound/${id}/retry`);
export const getB2COutbound = (filters = {}) => request(`/b2c/outbound${query(filters)}`);
export const retryB2COutbound = id => post(`/b2c/outbound/${id}/retry`);
// Emails waiting for the customer to register (no ticket yet). B2C admins only.
export const getB2CRegistrations = (filters = {}) => request(`/b2c/registrations${query(filters)}`);
export const getB2CRegistration = id => request(`/b2c/registrations/${id}`);
export const b2cRegistrationAction = (id, action, payload) => post(`/b2c/registrations/${id}/actions/${action}`, payload);
// Customer registration link (public; the token is the only credential and is checked by the server).
const registrationPath = token => `/b2c/public/registration/${encodeURIComponent(token)}`;
export const openRegistration = token => publicB2CRequest(registrationPath(token));
export const submitRegistration = (token, details) => publicB2CRequest(registrationPath(token), { method: 'POST', body: details });
export const renewRegistration = token => publicB2CRequest(`${registrationPath(token)}/renew`, { method: 'POST', body: {} });
// TEST ADAPTER ONLY
export const injectB2CTestEmail = payload => post('/b2c/test-adapter/inbound', payload);
export const getB2CTestOutbox = () => request('/b2c/test-adapter/outbox');
