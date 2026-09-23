import { Bell, FilePlus2, Laptop, LayoutDashboard, MessageSquareText, ShieldCheck, Sparkles, Ticket, UserRound, UserRoundPlus } from 'lucide-react';
import { AppShell, Badge as UIBadge, EmptyState, PageHeader, RowAction, KPI } from '../ui';
import { getNotificationUnreadCount } from './api';

export const corporatePortal = {
  key: 'corporate',
  portalName: 'Corporate Self-Care',
  roleLabel: 'Corporate Admin',
  home: '/corporate/dashboard',
  notificationsRoute: '/corporate/notifications',
  accountRoute: '/corporate/profile',
  accountLabel: 'Profile',
  fetchUnread: getNotificationUnreadCount,
  search: { route: '/corporate/devices', placeholder: 'Search devices, serials, employees' },
  groups: [
    { label: 'Overview', items: [{ to: '/corporate/dashboard', icon: LayoutDashboard, label: 'Dashboard' }] },
    { label: 'Operations', items: [
      { to: '/corporate/devices', icon: Laptop, label: 'Devices' },
      { to: '/corporate/unassigned-devices', icon: UserRoundPlus, label: 'Unassigned Devices' },
      { to: '/corporate/service-requests', icon: Ticket, label: 'Service Requests' },
    ] },
    { label: 'Service', items: [
      { to: '/corporate/raise-request', icon: FilePlus2, label: 'Raise Request' },
      { to: '/corporate/warranty', icon: ShieldCheck, label: 'Warranty & Coverage' },
    ] },
    { label: 'Communication', items: [
      { to: '/corporate/notifications', icon: Bell, label: 'Notifications', badge: 'unread' },
      { to: '/corporate/reviews', icon: MessageSquareText, label: 'Reviews' },
    ] },
    { label: 'Support', items: [{ action: 'ai', icon: Sparkles, label: 'AI Support' }] },
    { label: 'Account', items: [{ to: '/corporate/profile', icon: UserRound, label: 'Profile' }] },
  ],
};

export function Shell({ children, title, crumbs }) {
  return <AppShell config={corporatePortal} title={title} crumbs={crumbs}>{children}</AppShell>;
}

// Compatibility exports for modules that still import the previous helpers.
export const Badge = UIBadge;
export function PageTitle({ title, description, action, showTitle = false }) { return <PageHeader title={showTitle ? title : undefined} description={description} actions={action} />; }
export function Empty({ message }) { return <EmptyState compact title={message} />; }
export function RowLink({ children, to }) { return <RowAction to={to} label={children} />; }
export function Metric({ label, value, note }) { return <KPI label={label} value={value} hint={note} />; }
