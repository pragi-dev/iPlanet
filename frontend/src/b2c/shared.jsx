import { Bell, ChartPie, Inbox, LayoutDashboard, ListChecks, PlugZap, SlidersHorizontal, UserPlus, UserRoundCheck } from 'lucide-react';
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
      { label: 'Escalations', items: [{ to: '/b2c/tickets', icon: Inbox, label: 'Escalation Queue', match: ['/b2c/tickets/'] }, ...(admin ? [{ to: '/b2c/registrations', icon: UserPlus, label: 'Awaiting Registration' }] : [])] },
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
  // Customer (matched in the customer records before any region is used).
  customer_not_found: 'No serial number, and no registered customer matches the sender or the contact details in the email',
  customer_match_insufficient: 'Fewer than two of name, email and phone match the same registered customer',
  customer_ambiguous: 'The details match more than one registered customer',
  customer_identifiers_conflict: 'The details in the email belong to different registered customers',
  serial_customer_conflict: 'The serial number in the email is not registered to the identified customer',
  // Device (the matched customer's registered devices).
  customer_device_ambiguous: 'The customer has several registered devices and the email gives no serial number',
  customer_has_no_device: 'The customer has no registered device',
  serial_registered_to_other_customer: 'The serial number in the email is registered to a different customer',
  serial_not_registered_to_customer: 'The serial number in the email is not registered to this customer',
  registered_device_not_found: 'No device record has the customer\'s registered serial number',
  // Region (taken from the device record).
  serial_number_missing: 'No serial number, so the device and its region are unknown',
  multiple_serial_numbers: 'The email gives more than one serial number',
  serial_number_invalid: 'The serial number is not in a valid format',
  serial_not_found: 'No device record has this serial number',
  multiple_device_matches: 'More than one device record has this serial number',
  device_region_missing: 'The device record has no region (location)',
  no_regional_assignee: 'Nobody holds the first workflow level for this region',
  // Customer registration (sent when the sender cannot be identified).
  customer_registration_pending: 'Waiting for the customer to complete the registration form',
  customer_registration_review: 'The customer\'s registration needs a decision',
  customer_registration_expired: 'The registration link expired without a submission',
};

// The registration request's state as staff see it ('Ticket created and assigned' is a
// completed registration whose ticket has an owner).
export const REGISTRATION_STATUS = {
  required: { label: 'Registration required — no email sent', tone: 'warning' },
  not_requested: { label: 'Registration required — no email sent', tone: 'warning' },
  email_pending: { label: 'Registration email pending', tone: 'info' },
  email_sent: { label: 'Registration email sent', tone: 'info' },
  email_failed: { label: 'Registration email failed', tone: 'critical' },
  in_progress: { label: 'Registration in progress', tone: 'info' },
  processing: { label: 'Registration being checked', tone: 'info' },
  completed: { label: 'Registration completed', tone: 'success' },
  manual_review: { label: 'Manual review required', tone: 'warning' },
  expired: { label: 'Registration expired', tone: 'warning' },
  cancelled: { label: 'Registration withdrawn', tone: 'neutral' },
};
export const registrationLabel = (registration, assigned) => (registration?.status === 'completed' && assigned ? 'Ticket created and assigned' : REGISTRATION_STATUS[registration?.status]?.label);
// Why a registration needs a person, or why no link was sent.
export const REGISTRATION_REASONS = {
  serial_number_missing: 'No serial number was given and no existing customer matched, so no purchase record was created',
  serial_not_found: 'No device record has the serial number the customer gave',
  multiple_device_matches: 'More than one device record has this serial number',
  device_region_missing: 'The device record has no purchase region',
  purchase_region_mismatch: 'The region the customer chose differs from the device record',
  purchase_date_mismatch: 'The purchase date differs from the device record',
  serial_registered_to_other_customer: 'The device is registered to a different customer',
  customer_details_partial_match: 'Some details match an existing customer, but not enough to identify them',
  customer_ambiguous: 'The details match more than one customer',
  customer_identifiers_conflict: 'The details belong to different customers',
  too_many_failed_attempts: 'Too many invalid form submissions; the link was withdrawn',
  portal_url_not_configured: 'The registration page address is not configured',
  no_outbound_sender: 'No email can be sent for this inbox',
  invalid_recipient: 'The sender address is not a valid email address',
  recipient_daily_limit: 'This address reached the daily limit of registration emails',
  receive_only_inbox: 'The inbox is receive-only',
  resolved_by_staff: 'Staff triaged or closed the escalation',
  ticket_created_by_staff: 'A B2C admin created the ticket without registration',
};
// Why a ticket was created after its email arrived.
const CREATED_AFTER = { registration: 'After the customer registered', staff: 'By a B2C admin, without registration' };
const REGISTRATION_RECORDS = { existing: 'existing customer record', linked: 'existing customer, device added', created: 'new customer record' };

// How the routing region was decided.
export const REGION_STATUS = {
  automatic: { label: 'Automatic', tone: 'success', description: 'From the matched customer\'s device record' },
  manual: { label: 'Manual', tone: 'info', description: 'Chosen by a B2C admin in triage' },
  unresolved: { label: 'Unresolved', tone: 'warning', description: 'Needs manual review' },
  pending: { label: 'Pending', tone: 'neutral', description: 'Waiting for the device lookup' },
};
export const REGION_SOURCES = { device_location: 'Device record', manual: 'B2C admin decision' };

// Whether the email was matched to a registered customer, and by what.
export const CUSTOMER_MATCH = {
  matched: { label: 'Matched', tone: 'success' },
  not_found: { label: 'Not found', tone: 'warning' },
  insufficient: { label: 'Not enough matching details', tone: 'warning' },
  ambiguous: { label: 'Ambiguous', tone: 'warning' },
  conflict: { label: 'Conflicting details', tone: 'warning' },
  pending: { label: 'Pending', tone: 'neutral' },
};
// Audit note when the serial number routed a ticket for a sender who is not its registered customer.
const OWNER_NOTES = { customer_not_matched: 'sender not a registered customer', other_customer: 'serial number registered to a different customer', not_registered: 'serial number not registered to a customer' };
// Matching methods and the details they used (the first three: tickets matched by one detail before the two-detail rule).
export const CUSTOMER_MATCH_METHODS = {
  sender_email: 'Sender\'s email address', message_email: 'Email address in the message', phone: 'Phone number',
  contact_details: 'Contact details', serial_and_contact: 'Serial number and contact details',
  name: 'Name', email: 'Email address', serial: 'Registered serial number', registration: 'Customer registration form',
};
const ASSIGNMENT_NOTES = { automatic: 'automatic: the only eligible person', manual: 'chosen in triage' };
const matchedByText = details => (details.matchedBy?.length ? details.matchedBy.map(field => CUSTOMER_MATCH_METHODS[field] || field).join(' + ').toLowerCase() : CUSTOMER_MATCH_METHODS[details.customerMatch]?.toLowerCase());

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
  sent: 'Acknowledgement sent', failed: 'Acknowledgement failed', skipped: 'No acknowledgement sent',
};
// Why no acknowledgement was sent (tickets without a reason predate the company sender: receive-only inbox).
const ACK_SKIPPED = { customer_not_verified: 'customer not verified', invalid_recipient: 'no valid customer address', receive_only_inbox: 'receive-only inbox' };
export const ackLabel = ack => (ack?.status === 'skipped' ? `${ACK_STATUS.skipped} (${ACK_SKIPPED[ack.reason] || 'receive-only inbox'})` : ACK_STATUS[ack?.status]);

export const IDENTIFIER_LABELS = { caseId: 'Case ID', serialNumber: 'Serial number', orderNumber: 'Order number', other: 'Other' };

const AUDIT_LABELS = {
  created_from_email: 'Created from email', crm_lookup: 'CRM lookup', crm_lookup_failed: 'CRM lookup failed', crm_not_configured: 'CRM not connected',
  region_identified: 'Region identified from customer device', region_not_identified: 'Region not identified', region_set: 'Region set in triage',
  category_identified: 'Category identified from rules', queued_for_triage: 'Queued for triage', triage_completed: 'Triage completed', routed: 'Routed to workflow', acknowledgement_queued: 'Acknowledgement queued',
  email_sent: 'Email sent', email_send_failed: 'Email send failed', email_not_sent: 'Customer email not sent', customer_replied: 'Customer replied', sla_escalation: 'SLA escalation', set_priority: 'Priority changed (no longer used)', claim: 'Took ownership', assign: 'Engineer assigned', accept: 'Engineer accepted',
  start: 'Work started', escalate: 'Escalated to next level', reroute: 'Rerouted', set_path: 'Workflow path changed', request_clarification: 'Clarification requested',
  propose_resolution: 'Repair completion submitted', approve_resolution: 'Resolution approved', reject_resolution: 'Resolution returned for rework',
  close: 'Closed', close_unresolved: 'Closed without resolution', reopen: 'Reopened', add_note: 'Internal note', attachment_downloaded: 'Attachment downloaded',
  registration_requested: 'Customer registration requested', registration_not_requested: 'Customer registration not requested', registration_resent: 'Registration link sent again',
  registration_opened: 'Registration link opened', registration_completed: 'Customer registration completed', registration_needs_review: 'Customer registration needs review',
  registration_expired: 'Registration link expired', registration_cancelled: 'Customer registration withdrawn', send_registration: 'Registration link sent',
  registration_email_failed: 'Registration email failed', ticket_created_without_registration: 'Ticket created without customer registration',
};
export const EMAIL_KINDS = { acknowledgement: 'acknowledgement', clarification: 'clarification request', final: 'final customer email', registration: 'registration request' };

function auditSummary(event) {
  const details = event.details || {};
  switch (event.action) {
    case 'routed': return `${details.level}${details.region ? ` · ${details.region}` : ''}${details.assignee ? ` · assigned to ${details.assignee}${ASSIGNMENT_NOTES[details.assignment] ? ` (${ASSIGNMENT_NOTES[details.assignment]})` : ''}` : ' · waiting for an owner'}${details.path?.length ? ` (path: ${details.path.join(' → ')})` : ''}`;
    case 'region_identified': return `${details.region} · ${REGION_SOURCES[details.source] || details.source}${CUSTOMER_MATCH_METHODS[details.customerMatch] ? ` · customer matched by ${matchedByText(details)}` : ''}${OWNER_NOTES[details.ownerCheck] ? ` · ${OWNER_NOTES[details.ownerCheck]}` : ''}`;
    case 'region_not_identified': return TRIAGE_REASONS[details.reason] || details.reason;
    // Retried when an engineer was assigned, after an earlier attempt could not be sent.
    case 'acknowledgement_queued': return details.onAssignment ? `Engineer assigned · earlier attempt not sent (${ACK_SKIPPED[details.previousReason] || details.previousReason})` : '';
    case 'acknowledgement_not_sent': return `${ACK_SKIPPED[details.reason] || details.reason || ''}${details.onAssignment ? ' · checked again on engineer assignment' : ''}`;
    case 'region_set': return `${details.from ? `${details.from} → ` : ''}${details.to}${details.previousReason ? ` (was: ${TRIAGE_REASONS[details.previousReason] || details.previousReason})` : ''}`;
    case 'escalate': case 'reroute': return `${details.fromLevel} → ${details.toLevel}${details.assignee ? ` · ${details.assignee}` : ' · waiting for an owner'}`;
    case 'assign': return `${details.from ? `${details.from} → ` : ''}${details.to}`;
    case 'crm_lookup': return `Result: ${CRM_STATUS[details.result]?.label || details.result}${details.matchedBy ? ` (by ${details.matchedBy})` : ''}`;
    case 'crm_lookup_failed': return `Attempt ${details.attempt}${details.willRetry ? ', will retry' : ', no more automatic retries'}`;
    case 'queued_for_triage': return (details.reasons || []).map(reason => TRIAGE_REASONS[reason] || reason).join('; ');
    case 'category_identified': return `Category ${details.category}`;
    case 'triage_completed': return `${details.automatic ? 'Automatic · ' : ''}Category ${details.category}${details.region ? ` · region ${details.region}` : ''}${details.assignee ? ` · assigned to ${details.assignee}` : ''}${details.overriddenReasons?.length ? ` · overrode: ${details.overriddenReasons.map(reason => TRIAGE_REASONS[reason] || reason).join('; ')}` : ''}`;
    case 'email_sent': return `Customer ${EMAIL_KINDS[details.kind] || 'email'} sent${details.mode === 'test' ? ' (test adapter — not delivered)' : ''}`;
    case 'email_not_sent': return `Customer ${EMAIL_KINDS[details.kind] || 'email'} not sent: the inbox is receive-only (IMAP)`;
    case 'email_send_failed': return `Customer ${EMAIL_KINDS[details.kind] || 'email'}: attempt ${details.attempt} failed${details.willRetry ? ', will retry' : ''}`;
    case 'set_path': return (details.path || []).join(' → ');
    case 'propose_resolution': return details.validator ? `Validator: ${details.validator}` : details.validation === 'not required' ? 'Resolved without validation' : '';
    case 'attachment_downloaded': return details.filename;
    case 'registration_requested': return `${details.manual ? 'Sent by staff' : 'Automatic'} · ${details.trigger === 'insufficient' ? 'not enough details matched' : 'no registered customer matched'}${details.ticketCreated === false ? ' · no ticket until the customer registers' : ''}`;
    case 'registration_not_requested': case 'registration_needs_review': case 'registration_email_failed': return REGISTRATION_REASONS[details.reason] || details.reason || '';
    case 'registration_resent': return `Email ${details.sendNumber}${details.trigger === 'customer_renewal' ? ' · requested by the customer from an expired link' : ''}`;
    case 'registration_completed': return details.routingUnchanged ? 'Routing left unchanged (already triaged)' : `${REGISTRATION_RECORDS[details.customerRecord] || details.customerRecord}${details.region ? ` · region ${details.region} from the device record` : ' · the device record has no region'}`;
    case 'created_from_email': return `${CREATED_AFTER[details.after] ? `${CREATED_AFTER[details.after]} · ` : ''}Inbox ${details.inbox} · ${details.category}${details.identifierTypes?.length ? ` · identifiers: ${details.identifierTypes.map(type => IDENTIFIER_LABELS[type] || type).join(', ')}` : ''}`;
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
