import { Shell } from './components';
import { getNotifications, markAllNotificationsRead, markNotificationRead } from './api';
import { NotificationCenter } from '../ui';

function corporateRoute(item) {
  if (item.action?.route) return item.action.route;
  if (item.ticket?._id) return `/corporate/service-requests/${item.ticket._id}`;
  if (item.device?._id) return `/corporate/devices/${item.device._id}`;
  if (item.type === 'NEW_DEVICE') return '/corporate/devices?allocation=Unassigned';
  return null;
}

export function Notifications() {
  return <Shell title="Notifications">
    <NotificationCenter load={getNotifications} markRead={markNotificationRead} markAllRead={markAllNotificationsRead} resolveRoute={corporateRoute} description="Updates on your devices, service requests and coverage from iPlanet Service." />
  </Shell>;
}
