import { BarChart3, Bell, CalendarClock, FilePlus2, Laptop, LayoutDashboard, MessageSquareText, Search, ShieldCheck, Sparkles, Ticket, UserRound } from 'lucide-react';
import { AppShell, Badge as UIBadge, EmptyState, PageHeader, RowAction, KPI } from '../ui';
import { getDevices, getNotificationUnreadCount, getTickets } from './api';

// Command-bar index: the organization's own service requests and devices.
// Nothing beyond these API results. Employee details are not shown in the portals.
async function loadCommandIndex() {
  const [tickets, devices] = await Promise.all([getTickets(), getDevices()]);
  return [
    ...tickets.map(ticket => ({ id: `t-${ticket._id}`, group: 'Service requests', icon: Ticket, mono: true, title: ticket.ticketId, subtitle: [ticket.issueType, ticket.deviceId?.model, ticket.status].filter(Boolean).join(' · '), keywords: [ticket.deviceId?.serialNumber, ticket.location, ticket.assignedEngineer, ticket.category].join(' '), to: `/corporate/service-requests/${ticket._id}` })),
    ...devices.map(device => ({ id: `d-${device._id}`, group: 'Devices', icon: Laptop, title: device.model, subtitle: [device.serialNumber, device.location].filter(Boolean).join(' · '), keywords: [device.assetId, device.department, device.deviceType].join(' '), to: `/corporate/devices/${device._id}` })),
  ];
}

export const corporatePortal = {
  key: 'corporate',
  portalName: 'Corporate Self-Care',
  roleLabel: 'Corporate Admin',
  home: '/corporate/dashboard',
  notificationsRoute: '/corporate/notifications',
  accountRoute: '/corporate/profile',
  accountLabel: 'Profile',
  fetchUnread: getNotificationUnreadCount,
  commands: {
    load: loadCommandIndex,
    actions: [
      { id: 'a-raise', icon: FilePlus2, title: 'Raise service request', keywords: 'new create repair ticket', to: '/corporate/raise-request' },
      { id: 'a-find', icon: Search, title: 'Find a device', keywords: 'serial model employee search', to: '/corporate/devices' },
      { id: 'a-coverage', icon: ShieldCheck, title: 'Check coverage', keywords: 'warranty amc expiry expiring expired', to: '/corporate/warranty' },
      { id: 'a-service', icon: CalendarClock, title: 'Review recommended service', keywords: 'preventive maintenance due service recommended', to: '/corporate/service-recommendations' },
      { id: 'a-track', icon: Ticket, title: 'Track service requests', keywords: 'status tickets progress open', to: '/corporate/service-requests' },
      { id: 'a-ai', icon: Sparkles, title: 'Ask AI Support', keywords: 'help troubleshoot chat assistant', run: 'ai' },
    ],
  },
  groups: [
    { label: 'Overview', items: [{ to: '/corporate/dashboard', icon: LayoutDashboard, label: 'Overview' }] },
    { label: 'Devices', items: [
      { to: '/corporate/devices', icon: Laptop, label: 'Devices' },
    ] },
    { label: 'Service', items: [
      { to: '/corporate/service-requests', icon: Ticket, label: 'Service Requests' },
      { to: '/corporate/raise-request', icon: FilePlus2, label: 'Raise Request' },
      { to: '/corporate/service-recommendations', icon: CalendarClock, label: 'Service Recommended' },
    ] },
    { label: 'Coverage', items: [
      { to: '/corporate/warranty', icon: ShieldCheck, label: 'Warranty & Coverage' },
    ] },
    { label: 'Communication', items: [
      { to: '/corporate/notifications', icon: Bell, label: 'Notifications', badge: 'unread' },
      { to: '/corporate/reviews', icon: MessageSquareText, label: 'Reviews' },
      { to: '/corporate/reports', icon: BarChart3, label: 'Reports' },
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
