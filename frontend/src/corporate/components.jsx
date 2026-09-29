import { Bell, CalendarClock, FilePlus2, Laptop, LayoutDashboard, MessageSquareText, Search, ShieldCheck, Sparkles, Ticket, UserRound, UserRoundPlus } from 'lucide-react';
import { AppShell, Badge as UIBadge, EmptyState, PageHeader, RowAction, KPI } from '../ui';
import { getDevices, getNotificationUnreadCount, getTickets } from './api';

// Command-bar index: the organization's own service requests, devices and the
// employees those devices are assigned to. Nothing beyond these API results.
async function loadCommandIndex() {
  const [tickets, devices] = await Promise.all([getTickets(), getDevices()]);
  const employees = new Map();
  devices.forEach(device => {
    if (!device.employeeName) return;
    const key = device.employeeId || device.employeeName;
    const entry = employees.get(key) || { name: device.employeeName, employeeId: device.employeeId, department: device.department, count: 0 };
    entry.count += 1;
    employees.set(key, entry);
  });
  return [
    ...tickets.map(ticket => ({ id: `t-${ticket._id}`, group: 'Service requests', icon: Ticket, mono: true, title: ticket.ticketId, subtitle: [ticket.issueType, ticket.deviceId?.model, ticket.status].filter(Boolean).join(' · '), keywords: [ticket.deviceId?.serialNumber, ticket.location, ticket.assignedEngineer, ticket.category].join(' '), to: `/corporate/service-requests/${ticket._id}` })),
    ...devices.map(device => ({ id: `d-${device._id}`, group: 'Devices', icon: Laptop, title: device.model, subtitle: [device.serialNumber, device.employeeName || 'Unassigned', device.location].filter(Boolean).join(' · '), keywords: [device.assetId, device.employeeId, device.department, device.deviceType].join(' '), to: `/corporate/devices/${device._id}` })),
    ...[...employees.values()].map(person => ({ id: `e-${person.employeeId || person.name}`, group: 'Employees', icon: UserRound, title: person.name, subtitle: [person.employeeId, person.department, `${person.count} device${person.count === 1 ? '' : 's'}`].filter(Boolean).join(' · '), to: `/corporate/devices?search=${encodeURIComponent(person.name)}` })),
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
      { id: 'a-coverage', icon: ShieldCheck, title: 'Check coverage', keywords: 'warranty amc expiry', to: '/corporate/warranty' },
      { id: 'a-service', icon: CalendarClock, title: 'Review recommended service', keywords: 'preventive maintenance due service recommended', to: '/corporate/service-recommendations' },
      { id: 'a-track', icon: Ticket, title: 'Track service requests', keywords: 'status tickets progress', to: '/corporate/service-requests' },
      { id: 'a-unassigned', icon: UserRoundPlus, title: 'Assign a device to an employee', keywords: 'unassigned allocate', to: '/corporate/unassigned-devices' },
      { id: 'a-ai', icon: Sparkles, title: 'Ask AI Support', keywords: 'help troubleshoot chat assistant', run: 'ai' },
    ],
  },
  groups: [
    { label: 'Overview', items: [{ to: '/corporate/dashboard', icon: LayoutDashboard, label: 'Overview' }] },
    { label: 'Devices', items: [
      { to: '/corporate/devices', icon: Laptop, label: 'Devices' },
      { to: '/corporate/unassigned-devices', icon: UserRoundPlus, label: 'Unassigned Devices' },
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
