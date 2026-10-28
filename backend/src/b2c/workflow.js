import { B2C_ADMIN, CATEGORIES } from './b2cDefaults.js';

// Escalation workflow rules. The main stages match B2B service tickets:
// Request created (Open) → Engineer assigned → Engineer accepted → Work started
// (In Progress) → Repair completed (Completed) → Closed. Pending Triage, Awaiting
// Customer, Pending Validation and Reopened are side states within those stages. Every check here is enforced by the API; the UI
// only shows what `allowedActions` returns.
export const STATUS = {
  TRIAGE: 'Pending Triage',
  OPEN: 'Open',
  ASSIGNED: 'Engineer Assigned',
  ACCEPTED: 'Engineer Accepted',
  INVESTIGATING: 'In Progress',
  AWAITING_CUSTOMER: 'Awaiting Customer',
  PENDING_VALIDATION: 'Pending Validation',
  RESOLVED: 'Completed',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
};
const { TRIAGE, OPEN, ASSIGNED, ACCEPTED, INVESTIGATING, AWAITING_CUSTOMER, PENDING_VALIDATION, RESOLVED, CLOSED, REOPENED } = STATUS;
export const ACTIVE_STATUSES = [TRIAGE, OPEN, ASSIGNED, ACCEPTED, INVESTIGATING, AWAITING_CUSTOMER, PENDING_VALIDATION, REOPENED];
const WORKING = [ASSIGNED, ACCEPTED, INVESTIGATING, AWAITING_CUSTOMER, REOPENED];

const id = value => (value === undefined || value === null ? '' : String(value?._id || value));
export const isAdmin = user => user?.b2cRole === B2C_ADMIN;
export const isAssignee = (ticket, user) => Boolean(id(ticket.workflow?.assignee?.userId)) && id(ticket.workflow.assignee.userId) === id(user?.id);
export const regionAllowed = (ticket, user) => !user?.b2cRegions?.length || user.b2cRegions.includes(ticket.region);
const atUsersLevel = (ticket, user) => Boolean(user?.b2cRole) && ticket.workflow?.currentLevel === user.b2cRole && regionAllowed(ticket, user);

export function enabledLevels(settings) {
  return [...(settings?.workflowLevels || [])].filter(level => level.enabled).sort((a, b) => a.order - b.order);
}
export const levelLabel = (settings, key) => settings?.workflowLevels?.find(level => level.key === key)?.label || key || 'Unassigned level';

// The ticket's path keeps only levels that are still enabled.
export function effectivePath(ticket, settings) {
  const enabled = new Set(enabledLevels(settings).map(level => level.key));
  return (ticket.workflow?.path || []).filter(key => enabled.has(key));
}
export function nextLevel(ticket, settings) {
  const path = effectivePath(ticket, settings);
  const index = path.indexOf(ticket.workflow?.currentLevel);
  return index >= 0 ? path[index + 1] || null : path[0] || null;
}
// New escalations pass through every enabled level in order, for both categories.
export function defaultPath(settings) {
  return enabledLevels(settings).map(level => level.key);
}
// Which level must validate a proposed resolution. null = B2C admin only;
// false = no validation step.
export function validatorLevelFor(ticket, settings) {
  const mode = settings?.validation?.mode || 'next_level';
  if (mode === 'none') return false;
  if (mode === 'level') return settings.validation.levelKey || null;
  return nextLevel(ticket, settings);
}

export function isValidator(ticket, user) {
  if (ticket.status !== PENDING_VALIDATION) return false;
  // Nobody validates their own proposal.
  if (id(ticket.validation?.proposedBy?.userId) === id(user?.id)) return false;
  if (isAdmin(user)) return true;
  return Boolean(ticket.validation?.validatorLevel) && ticket.validation.validatorLevel === user?.b2cRole && regionAllowed(ticket, user);
}

export function canView(ticket, user) {
  if (!user?.b2cRole) return false;
  if (isAdmin(user) || isAssignee(ticket, user)) return true;
  if ((ticket.participants || []).some(participant => id(participant) === id(user.id))) return true;
  if (ticket.status !== TRIAGE && atUsersLevel(ticket, user)) return true;
  return ticket.status === PENDING_VALIDATION && isValidator(ticket, user);
}

// MongoDB filter equivalent of canView, for queue listings.
export function visibilityFilter(user) {
  if (isAdmin(user)) return {};
  const regions = user?.b2cRegions?.length ? { region: { $in: user.b2cRegions } } : {};
  return { $or: [
    { 'workflow.assignee.userId': user.id },
    { participants: user.id },
    { 'workflow.currentLevel': user.b2cRole, status: { $ne: TRIAGE }, ...regions },
    { status: PENDING_VALIDATION, 'validation.validatorLevel': user.b2cRole, 'validation.proposedBy.userId': { $ne: user.id }, ...regions },
  ] };
}

export const ACTIONS = {
  complete_triage: { label: 'Complete triage', statuses: [TRIAGE], allowed: ({ user }) => isAdmin(user) },
  // Offered only while registration is enabled and the customer is not identified (b2cService).
  send_registration: { label: 'Send registration link', statuses: [TRIAGE], allowed: ({ user }) => isAdmin(user) },
  retry_crm: { label: 'Retry CRM lookup', statuses: ACTIVE_STATUSES, allowed: ({ ticket, user }) => isAdmin(user) || isAssignee(ticket, user) },
  claim: { label: 'Take ownership', statuses: [OPEN, REOPENED], allowed: ({ ticket, user }) => !ticket.workflow?.assignee?.userId && atUsersLevel(ticket, user) },
  assign: { label: 'Assign', statuses: [OPEN, ...WORKING], allowed: ({ ticket, user }) => isAdmin(user) || isAssignee(ticket, user) },
  accept: { label: 'Accept assignment', statuses: [ASSIGNED], allowed: ({ ticket, user }) => isAssignee(ticket, user) },
  start: { label: 'Start work', statuses: [ACCEPTED, REOPENED], allowed: ({ ticket, user }) => isAssignee(ticket, user) },
  reroute: { label: 'Reroute', statuses: [OPEN, ...WORKING], requires: ['reason'], allowed: ({ ticket, user }) => isAdmin(user) || isAssignee(ticket, user) },
  set_path: { label: 'Edit workflow path', statuses: [OPEN, ...WORKING], allowed: ({ user }) => isAdmin(user) },
  request_clarification: { label: 'Request clarification', statuses: [ASSIGNED, ACCEPTED, INVESTIGATING, REOPENED], requires: ['message'], allowed: ({ ticket, user }) => isAdmin(user) || isAssignee(ticket, user) },
  propose_resolution: { label: 'Complete repair', statuses: [INVESTIGATING], requires: ['resolutionSummary', 'customerMessage'], allowed: ({ ticket, user }) => isAssignee(ticket, user) },
  approve_resolution: { label: 'Approve resolution', statuses: [PENDING_VALIDATION], allowed: ({ ticket, user }) => isValidator(ticket, user) },
  reject_resolution: { label: 'Return for rework', statuses: [PENDING_VALIDATION], requires: ['reason'], allowed: ({ ticket, user }) => isValidator(ticket, user) },
  close: { label: 'Close', statuses: [RESOLVED], allowed: ({ ticket, user }) => isAdmin(user) || isAssignee(ticket, user) },
  close_unresolved: { label: 'Close without resolution', statuses: [TRIAGE, OPEN, ...WORKING], requires: ['reason'], allowed: ({ user }) => isAdmin(user) },
  reopen: { label: 'Reopen', statuses: [RESOLVED, CLOSED], requires: ['reason'], allowed: ({ ticket, user }) => isAdmin(user) || isAssignee(ticket, user) },
  add_note: { label: 'Add internal note', statuses: [...ACTIVE_STATUSES, RESOLVED, CLOSED], requires: ['note'], allowed: ({ ticket, user }) => canView(ticket, user) },
};

export function canPerform(action, { ticket, user, settings }) {
  const definition = ACTIONS[action];
  if (!definition || !canView(ticket, user)) return false;
  return definition.statuses.includes(ticket.status) && definition.allowed({ ticket, user, settings });
}

export function allowedActions(context) {
  return Object.keys(ACTIONS).filter(action => canPerform(action, context));
}

// Status after a ticket lands on a level with or without a named assignee.
export const statusForAssignment = assignee => (assignee?.userId ? ASSIGNED : OPEN);

// A staff member may hold a level only for tickets in their regions.
export function eligibleForLevel(staff, levelKey, ticket) {
  return staff.b2cRole === levelKey && (!staff.b2cRegions?.length || staff.b2cRegions.includes(ticket.region));
}

export function validateCategory(category) {
  return CATEGORIES.includes(category);
}
