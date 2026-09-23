import { BarChart3, Bell, LayoutDashboard, MessageSquareText, ScanLine, Settings, ShieldCheck, Siren, Ticket, UsersRound } from 'lucide-react';
import { AppShell, Badge as UIBadge, EmptyState, KPI, PageHeader } from '../ui';
import { getServiceNotificationUnreadCount } from './api';

export const servicePortal = {
  key: 'service',
  portalName: 'iPlanet Service',
  roleLabel: 'iPlanet Service',
  home: '/service/dashboard',
  notificationsRoute: '/service/notifications',
  accountRoute: '/service/settings',
  accountLabel: 'Settings',
  fetchUnread: getServiceNotificationUnreadCount,
  groups: [
    { label: 'Overview', items: [{ to: '/service/dashboard', icon: LayoutDashboard, label: 'Dashboard' }] },
    { label: 'Operations', items: [
      { to: '/service/tickets', icon: Ticket, label: 'Tickets' },
      { to: '/service/device-enrollment', icon: ScanLine, label: 'Device Enrollment' },
      { to: '/service/engineers', icon: UsersRound, label: 'Engineers' },
    ] },
    { label: 'Monitoring', items: [
      { to: '/service/reports', icon: BarChart3, label: 'Reports' },
      { to: '/service/warranty', icon: ShieldCheck, label: 'Warranty & Coverage' },
      { to: '/service/escalation', icon: Siren, label: 'Escalation Matrix' },
    ] },
    { label: 'Communication', items: [
      { to: '/service/notifications', icon: Bell, label: 'Notifications', badge: 'unread' },
      { to: '/service/reviews', icon: MessageSquareText, label: 'Reviews' },
    ] },
    { label: 'Account', items: [{ to: '/service/settings', icon: Settings, label: 'Settings' }] },
  ],
};

export function ServiceShell({ children, title, crumbs }) {
  return <AppShell config={servicePortal} title={title} crumbs={crumbs}>{children}</AppShell>;
}

// Compatibility exports for modules that still import the previous helpers.
export const Badge = UIBadge;
export function Empty({ message }) { return <EmptyState compact title={message} />; }
export function Metric({ label, value, note }) { return <KPI label={label} value={value} hint={note} />; }
export function PageTitle({ title, description, action, showTitle = false }) { return <PageHeader title={showTitle ? title : undefined} description={description} actions={action} />; }
