import { BarChart3, Bell, Building2, CalendarClock, ClipboardList, Laptop, LayoutDashboard, MessageSquareText, ScanLine, Settings, ShieldAlert, ShieldCheck, Siren, Ticket, UserRound, UserRoundX, UsersRound } from 'lucide-react';
import { AppShell, Badge as UIBadge, EmptyState, KPI, PageHeader } from '../ui';
import { getCompanies, getCoverage, getEngineers, getServiceNotificationUnreadCount, getServiceTickets } from './api';

// Command-bar index: tickets, engineers, corporates, enrolled devices and the
// employees on those devices — exactly what the service APIs return.
async function loadCommandIndex() {
  const [tickets, engineers, companies, coverage] = await Promise.all([getServiceTickets(), getEngineers(), getCompanies(), getCoverage()]);
  const devices = coverage?.devices || [];
  const employees = new Map();
  devices.forEach(device => {
    if (!device.employeeName) return;
    const key = `${device.companyId?._id || ''}:${device.employeeId || device.employeeName}`;
    if (!employees.has(key)) employees.set(key, { name: device.employeeName, employeeId: device.employeeId, company: device.companyId?.name });
  });
  return [
    ...tickets.map(ticket => ({ id: `t-${ticket._id}`, group: 'Tickets', icon: Ticket, mono: true, title: ticket.ticketId, subtitle: [ticket.issueType, ticket.companyId?.name || ticket.customerId?.company, ticket.status].filter(Boolean).join(' · '), keywords: [ticket.deviceId?.model, ticket.deviceId?.serialNumber, ticket.location, ticket.assignedEngineer].join(' '), to: `/service/tickets/${ticket._id}` })),
    ...devices.map(device => ({ id: `d-${device._id}`, group: 'Devices', icon: Laptop, title: device.model, subtitle: [device.serialNumber, device.companyId?.name || 'Not assigned', device.location].filter(Boolean).join(' · '), keywords: [device.assetId, device.employeeName, device.employeeId].join(' '), to: `/service/tickets?search=${encodeURIComponent(device.serialNumber)}` })),
    ...engineers.map(engineer => ({ id: `e-${engineer._id}`, group: 'Engineers', icon: UsersRound, title: engineer.name, subtitle: [engineer.location, engineer.status, `${engineer.assignedTicketCount || 0} open tickets`].filter(Boolean).join(' · '), keywords: [engineer.employeeId, engineer.email, engineer.phone].join(' '), to: `/service/engineers?engineer=${engineer._id}` })),
    ...companies.map(company => ({ id: `c-${company._id}`, group: 'Corporates', icon: Building2, title: company.name, subtitle: [company.location, company.contactName].filter(Boolean).join(' · '), keywords: [company.companyId, company.contactEmail].join(' '), to: `/service/tickets?companyId=${company._id}` })),
    ...[...employees.values()].map(person => ({ id: `p-${person.company}-${person.employeeId || person.name}`, group: 'Employees', icon: UserRound, title: person.name, subtitle: [person.employeeId, person.company].filter(Boolean).join(' · '), to: `/service/tickets?search=${encodeURIComponent(person.name)}` })),
  ];
}

export const servicePortal = {
  key: 'service',
  portalName: 'iPlanet Service',
  roleLabel: 'iPlanet Service',
  home: '/service/dashboard',
  notificationsRoute: '/service/notifications',
  accountRoute: '/service/settings',
  accountLabel: 'Settings',
  fetchUnread: getServiceNotificationUnreadCount,
  commands: {
    load: loadCommandIndex,
    actions: [
      { id: 'a-queue', icon: ClipboardList, title: 'Open ticket queue', keywords: 'tickets list', to: '/service/tickets' },
      { id: 'a-assign', icon: UserRoundX, title: 'Assign engineer to unassigned tickets', keywords: 'unassigned open engineer', to: '/service/tickets?status=Open&assignment=Unassigned' },
      { id: 'a-sla', icon: ShieldAlert, title: 'Review SLA at-risk tickets', keywords: 'sla risk breach escalation', to: '/service/tickets?slaStatus=At%20Risk' },
      { id: 'a-proactive', icon: CalendarClock, title: 'Review proactive service follow-ups', keywords: 'preventive maintenance due overdue service interval', to: '/service/proactive' },
      { id: 'a-enroll', icon: ScanLine, title: 'Enroll a device', keywords: 'serial scan register', to: '/service/device-enrollment' },
      { id: 'a-coverage', icon: ShieldCheck, title: 'Check coverage', keywords: 'warranty amc expiry', to: '/service/warranty' },
      { id: 'a-reports', icon: BarChart3, title: 'View reports', keywords: 'analytics charts', to: '/service/reports' },
      { id: 'a-escalation', icon: Siren, title: 'Escalation matrix', keywords: 'rules levels contacts', to: '/service/escalation' },
    ],
  },
  groups: [
    { label: 'Overview', items: [{ to: '/service/dashboard', icon: LayoutDashboard, label: 'Overview' }] },
    { label: 'Operations', items: [
      { to: '/service/tickets', icon: Ticket, label: 'Tickets' },
      { to: '/service/proactive', icon: CalendarClock, label: 'Proactive Service' },
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
