import { NotificationCenter } from '../ui';
import { apiRequest as request } from '../service/api';
import { B2CShell } from './shared';

const load = () => request('/b2c/notifications');
const markRead = id => request(`/b2c/notifications/${id}/read`, { method: 'PATCH', body: JSON.stringify({}) });
const markAllRead = () => request('/b2c/notifications/read-all', { method: 'PATCH', body: JSON.stringify({}) });

export function B2CNotifications() {
  return <B2CShell title="Notifications">
    <NotificationCenter load={load} markRead={markRead} markAllRead={markAllRead} resolveRoute={item => item.action?.route || null} pollMs={15000} description="Every activity-log entry on your B2C escalations: assignments, customer replies, validation requests and status changes." />
  </B2CShell>;
}
