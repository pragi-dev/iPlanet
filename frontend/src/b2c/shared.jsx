import { Bell, ChartPie, Inbox, LayoutDashboard, ListChecks, PlugZap, SlidersHorizontal, UserRoundCheck } from 'lucide-react';
import { AppShell, Badge, EmptyState, formatDateTime, readSessionUser } from '../ui';
import { servicePortalFor } from '../service/components';
import { getB2CTickets } from './api';
import { apiRequest as request } from '../service/api';

// Shared pieces of the B2C escalation pages.
export const B2C_ROLE_LABELS = {
  b2c_admin: 'B2C Admin',
  cluster_manager: 'Cluster Manager',
  rbh: 'Regional Business Head',
  trainer: 'Trainer',
  cd_team_am: 'CD Team Assistant Manager',
  service_excellence_lead: 'Service Excellence Lead',
};

export const isB2CAdmin = () => readSessionUser().b2cRole === 'b2c_admin';

async function loadCommandIndex() {
  const { items } = await getB2CTickets({ limit: 100, sort: 'lastActivityAt' });
  return items.map(ticket => ({ id: `b2c-${ticket._id}`, group: 'Escalations', icon: Inbox, mono: true, title: ticket.reference, subtitle: [ticket.subject, ticket.category, ticket.status].filter(Boolean).join(' · '), keywords: [ticket.customer?.name, ticket.customer?.email, ...(ticket.identifiers || []).map(item => item.value)].join(' '), to: `/b2c/tickets/${ticket._id}` }));
}

// Navigation for B2C-only accounts.
function b2cPortal(user) {
  const admin = user.b2cRole === 'b2c_admin';
  return {
    key: 'b2c',
    portalName: 'B2C Escalations',
    roleLabel: B2C_ROLE_LABELS[user.b2cRole] || 'B2C Escalations',
    home: '/b2c',
    notificationsRoute: '/b2c/notifications',
    accountRoute: '/b2c',
    accountLabel: 'Overview',
    fetchUnread: () => request('/b2c/notifications/unread-count'),
    commands: {
      load: loadCommandIndex,
      actions: [
        { id: 'b2c-queue', icon: Inbox, title: 'Open escalation queue', keywords: 'tickets list', to: '/b2c/tickets' },
        { id: 'b2c-mine', icon: UserRoundCheck, title: 'My escalations', keywords: 'assigned me', to: '/b2c/tickets?view=mine' },
        { id: 'b2c-validation', icon: ListChecks, title: 'Resolutions awaiting validation', keywords: 'approve validate', to: '/b2c/tickets?view=validation' },
      ],
    },
    groups: [
      { label: 'Overview', items: [{ to: '/b2c', end: true, icon: LayoutDashboard, label: 'Overview' }] },
      { label: 'Escalations', items: [{ to: '/b2c/tickets', icon: Inbox, label: 'Escalation Queue', match: ['/b2c/tickets/'] }] },
      { label: 'Monitoring', items: [{ to: '/b2c/reports', icon: ChartPie, label: 'Reports' }, ...(admin ? [{ to: '/b2c/integrations', icon: PlugZap, label: 'Integration Health' }] : [])] },
      { label: 'Communication', items: [{ to: '/b2c/notifications', icon: Bell, label: 'Notifications', badge: 'unread' }] },
      ...(admin ? [{ label: 'Administration', items: [{ to: '/b2c/settings', icon: SlidersHorizontal, label: 'B2C Settings' }] }] : []),
    ],
  };
}

// iPlanet Service accounts keep their own navigation (with the B2C group);
// B2C-only accounts get the B2C navigation.
export function B2CShell({ children, title, crumbs }) {
  const user = readSessionUser();
  const config = user.role === 'iplanet_service' ? servicePortalFor(user) : b2cPortal(user);
  return <AppShell config={config} title={title} crumbs={crumbs}>{children}</AppShell>;
}

// The API answers 403 for accounts without a B2C role.
export function NoB2CAccess() {
  return <div className="card"><EmptyState title="No access to B2C escalations" description="Your account does not have a B2C escalation role. Ask a B2C administrator to grant one." /></div>;
}

const STATUS_TONES = {
  'Pending Triage': 'warning', Open: 'info', 'Engineer Assigned': 'info', 'Engineer Accepted': 'info', 'In Progress': 'info', 'Awaiting Customer': 'neutral',
  'Pending Validation': 'warning', Completed: 'success', Closed: 'neutral', Reopened: 'warning',
};
export const B2C_STATUSES = Object.keys(STATUS_TONES);
export const ACTIVE_STATUSES = B2C_STATUSES.filter(status => !['Completed', 'Closed'].includes(status));

// The six stages shared with B2B service tickets. Side states sit inside a stage;
// the older names (Assigned, Investigating, Resolved) match earlier audit entries.
const JOURNEY_STAGES = [
  { label: 'Request created', statuses: ['Open', 'Pending Triage'] },
  { label: 'Engineer assigned', statuses: ['Engineer Assigned', 'Assigned'] },
  { label: 'Engineer accepted', statuses: ['Engineer Accepted'] },
  { label: 'Work started', statuses: ['In Progress', 'Investigating', 'Awaiting Customer', 'Pending Validation'] },
  { label: 'Repair completed', statuses: ['Completed', 'Resolved'] },
  { label: 'Closed', statuses: ['Closed'] },
];
const SIDE_STATE_NOTES = { 'Pending Triage': 'Waiting for triage', 'Awaiting Customer': 'Waiting for the customer', 'Pending Validation': 'Repair awaiting validation', Reopened: 'Reopened' };
export function b2cJourneySteps(ticket, audit = []) {
  const status = ticket.status;
  // A reopened ticket goes back to its owner, before work restarts.
  const current = status === 'Reopened' ? (ticket.workflow?.assignee?.userId ? 2 : 0) : Math.max(0, JOURNEY_STAGES.findIndex(stage => stage.statuses.includes(status)));
  const closed = status === 'Closed';
  const unresolved = closed && ticket.closure?.reason && ticket.closure.reason !== 'Resolved';
  const lastAt = (stage, index) => {
    if (index === 0) return ticket.createdAt;
    const events = audit.filter(event => stage.statuses.includes(event.toStatus) || (index === 2 && event.action === 'claim'));
    return events.length ? events[events.length - 1].at : null;
  };
  return JOURNEY_STAGES.map((stage, index) => {
    const reached = index < current || (closed && index === current);
    const state = unresolved && index > 0 && index < 5 && !lastAt(stage, index) ? 'skip' : reached ? 'done' : index === current ? (SIDE_STATE_NOTES[status] ? 'hold' : 'current') : 'upcoming';
    const at = state === 'done' || state === 'current' || state === 'hold' ? lastAt(stage, index) : null;
    const note = index === current && !closed ? SIDE_STATE_NOTES[status] : unresolved && index === 5 ? 'Closed without resolution' : null;
    return { key: stage.label, label: stage.label, state, meta: [note, at ? formatDateTime(at) : null].filter(Boolean).join(' · ') || undefined };
  });
}
export function B2CStatus({ status }) {
  return <Badge dot tone={STATUS_TONES[status] || 'neutral'}>{status}</Badge>;
}
export function CategoryBadge({ category }) {
  return <Badge tone={category === 'Unclassified' ? 'warning' : 'neutral'}>{category}</Badge>;
}

export const TRIAGE_REASONS = {
  missing_identifier: 'No case ID or serial number was found',
  ambiguous_category: 'The email matches both Service and Retail rules',
  unclassified_category: 'No Service or Retail rule matched',
  crm_no_match: 'No matching customer was found in the CRM',
  crm_multiple_matches: 'More than one CRM record matched',
  crm_error: 'The CRM lookup failed',
  no_workflow_path: 'No workflow level is enabled',
};

export const CRM_STATUS = {
  pending: { label: 'CRM lookup pending', tone: 'neutral' },
  not_configured: { label: 'CRM not connected', tone: 'neutral' },
  matched: { label: 'CRM matched', tone: 'success' },
  no_match: { label: 'No CRM match', tone: 'warning' },
  multiple_matches: { label: 'Multiple CRM matches', tone: 'warning' },
  error: { label: 'CRM lookup failed', tone: 'critical' },
};

export const ACK_STATUS = {
  pending: 'Acknowledgement pending', queued: 'Acknowledgement queued', held: 'Acknowledgement held — template not approved',
  sent: 'Acknowledgement sent', failed: 'Acknowledgement failed', skipped: 'No acknowledgement',
};

export const IDENTIFIER_LABELS = { caseId: 'Case ID', serialNumber: 'Serial number', orderNumber: 'Order number', other: 'Other' };

const AUDIT_LABELS = {
  created_from_email: 'Created from email', crm_lookup: 'CRM lookup', crm_lookup_failed: 'CRM lookup failed', crm_not_configured: 'CRM not connected',
  queued_for_triage: 'Queued for triage', triage_completed: 'Triage completed', routed: 'Routed to workflow', acknowledgement_queued: 'Acknowledgement queued',
  email_sent: 'Email sent', email_send_failed: 'Email send failed', customer_replied: 'Customer replied', sla_escalation: 'SLA escalation', set_priority: 'Priority changed (no longer used)', claim: 'Took ownership', assign: 'Engineer assigned', accept: 'Engineer accepted',
  start: 'Work started', escalate: 'Escalated to next level', reroute: 'Rerouted', set_path: 'Workflow path changed', request_clarification: 'Clarification requested',
  propose_resolution: 'Repair completion submitted', approve_resolution: 'Resolution approved', reject_resolution: 'Resolution returned for rework',
  close: 'Closed', close_unresolved: 'Closed without resolution', reopen: 'Reopened', add_note: 'Internal note', attachment_downloaded: 'Attachment downloaded',
};
const EMAIL_KINDS = { acknowledgement: 'acknowledgement', clarification: 'clarification request', final: 'final customer email' };

function auditSummary(event) {
  const details = event.details || {};
  switch (event.action) {
    case 'routed': return `${details.level}${details.assignee ? ` · assigned to ${details.assignee}` : ' · waiting for an owner'}${details.path?.length ? ` (path: ${details.path.join(' → ')})` : ''}`;
    case 'escalate': case 'reroute': return `${details.fromLevel} → ${details.toLevel}${details.assignee ? ` · ${details.assignee}` : ' · waiting for an owner'}`;
    case 'assign': return `${details.from ? `${details.from} → ` : ''}${details.to}`;
    case 'crm_lookup': return `Result: ${CRM_STATUS[details.result]?.label || details.result}${details.matchedBy ? ` (by ${details.matchedBy})` : ''}`;
    case 'crm_lookup_failed': return `Attempt ${details.attempt}${details.willRetry ? ', will retry' : ', no more automatic retries'}`;
    case 'queued_for_triage': return (details.reasons || []).map(reason => TRIAGE_REASONS[reason] || reason).join('; ');
    case 'triage_completed': return `Category ${details.category}${details.overriddenReasons?.length ? ` · overrode: ${details.overriddenReasons.map(reason => TRIAGE_REASONS[reason] || reason).join('; ')}` : ''}`;
    case 'email_sent': return `Customer ${EMAIL_KINDS[details.kind] || 'email'} sent${details.mode === 'test' ? ' (test adapter — not delivered)' : ''}`;
    case 'email_send_failed': return `Customer ${EMAIL_KINDS[details.kind] || 'email'}: attempt ${details.attempt} failed${details.willRetry ? ', will retry' : ''}`;
    case 'set_path': return (details.path || []).join(' → ');
    case 'propose_resolution': return details.validator ? `Validator: ${details.validator}` : details.validation === 'not required' ? 'Resolved without validation' : '';
    case 'attachment_downloaded': return details.filename;
    case 'created_from_email': return `Inbox ${details.inbox} · ${details.category}${details.identifierTypes?.length ? ` · identifiers: ${details.identifierTypes.map(type => IDENTIFIER_LABELS[type] || type).join(', ')}` : ''}`;
    default: return '';
  }
}

// Converts audit events to the shared ActivityTimeline shape.
export function auditTimeline(events = []) {
  return events.map(event => {
    const summary = auditSummary(event);
    return {
      _id: event._id,
      status: AUDIT_LABELS[event.action] || event.action.replace(/_/g, ' '),
      message: [summary, event.note].filter(Boolean).join(' — '),
      updatedBy: event.actor?.name,
      userRole: event.actor?.role === 'system' ? 'system' : B2C_ROLE_LABELS[event.actor?.role] || event.actor?.role,
      timestamp: event.at,
    };
  });
}

export function ageLabel(value) {
  const days = (Date.now() - new Date(value).getTime()) / 86400000;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hr`;
  return `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}`;
}

export function hoursLabel(hours) {
  if (hours === null || hours === undefined) return '—';
  return hours < 48 ? `${hours} hr` : `${Math.round((hours / 24) * 10) / 10} days`;
}
