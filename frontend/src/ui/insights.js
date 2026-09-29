// Derived, explainable signals built only from fields the API already returns.
// Nothing here estimates or invents values: every insight can be traced back
// to specific ticket, device or engineer records.
import { slaLabel } from './format';

export const ACTIVE_STATUSES = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts'];
export const isActiveTicket = ticket => ACTIVE_STATUSES.includes(ticket?.status);
export const idOf = value => String(value?._id || value || '');

// 'breached' | 'escalated' | 'risk' | null — only meaningful for active tickets.
export function slaRisk(ticket) {
  if (!isActiveTicket(ticket)) return null;
  const label = slaLabel(ticket);
  const escalation = ticket.escalationStatus;
  if (label === 'SLA Breached' || escalation === 'SLA Breached') return 'breached';
  if (label === 'Escalated' || escalation === 'Escalated') return 'escalated';
  if (label === 'At Risk' || escalation === 'At Risk') return 'risk';
  return null;
}

export const riskTone = risk => (risk === 'breached' || risk === 'escalated' ? 'critical' : risk === 'risk' ? 'warning' : 'neutral');
export const riskLabel = risk => ({ breached: 'SLA breached', escalated: 'Escalated', risk: 'SLA at risk' }[risk] || '');

const DAY = 86400000;

// Devices with two or more requests of the same issue type inside the window.
// Returns [{ deviceId, device, issueType, count, tickets, lastAt }] sorted by count.
export function recurringIssues(tickets, { windowDays = 90, minCount = 2 } = {}) {
  const since = Date.now() - windowDays * DAY;
  const groups = new Map();
  (tickets || []).forEach(ticket => {
    const created = new Date(ticket.createdAt).getTime();
    const deviceId = idOf(ticket.deviceId);
    if (!deviceId || !ticket.issueType || Number.isNaN(created) || (windowDays && created < since)) return;
    const key = `${deviceId}::${ticket.issueType}`;
    const group = groups.get(key) || { deviceId, device: typeof ticket.deviceId === 'object' ? ticket.deviceId : null, issueType: ticket.issueType, tickets: [] };
    group.tickets.push(ticket);
    groups.set(key, group);
  });
  return [...groups.values()]
    .filter(group => group.tickets.length >= minCount)
    .map(group => ({ ...group, count: group.tickets.length, lastAt: group.tickets.reduce((latest, ticket) => Math.max(latest, new Date(ticket.createdAt).getTime()), 0) }))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

// Suggests an engineer only when the data supports a clear reason: available,
// working in the ticket's service location, with the lightest open workload.
// Returns null rather than guessing when no engineer meets those conditions.
export function suggestEngineer(engineers, ticket) {
  const location = String(ticket?.location || '').toLowerCase();
  if (!location) return null;
  const candidates = (engineers || []).filter(engineer => engineer.status === 'Available' && String(engineer.location || '').toLowerCase() === location && idOf(engineer) !== idOf(ticket.assignedEngineerId));
  if (!candidates.length) return null;
  const [best] = [...candidates].sort((a, b) => (a.assignedTicketCount || 0) - (b.assignedTicketCount || 0) || String(a.name).localeCompare(String(b.name)));
  return { engineer: best, reasons: [`Works in ${best.location}`, 'Available', `${best.assignedTicketCount || 0} open ticket${best.assignedTicketCount === 1 ? '' : 's'}${candidates.length > 1 ? ' — lightest in this location' : ''}`] };
}

// Days until a date (negative when in the past); null when unknown.
export function daysUntil(value) {
  const time = new Date(value).getTime();
  if (!value || Number.isNaN(time)) return null;
  return Math.ceil((time - Date.now()) / DAY);
}

export function coverageExpiring(device) {
  const items = [];
  if (device.warrantyStatus === 'Expiring Soon') items.push({ kind: 'Warranty', date: device.warrantyExpiry });
  if (device.amcStatus === 'Expiring Soon') items.push({ kind: 'AMC', date: device.amcExpiry });
  return items;
}

// "45m", "1h 42m", "2d 3h", "41 days" — compact spans for SLA countdowns;
// precision drops as the span grows.
export function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
  return `${days} days`;
}

// Time left to the ticket's SLA target (from slaTargetAt). Null when no target is set.
export function slaCountdown(ticket, now = Date.now()) {
  const target = new Date(ticket?.slaTargetAt).getTime();
  if (!ticket?.slaTargetAt || Number.isNaN(target)) return null;
  const remaining = target - now;
  return { overdue: remaining < 0, text: formatDuration(remaining) };
}

// The same issue type reported on several different devices at one location
// inside the window. Returns [{ location, issueType, devices, tickets, since }].
export function issueClusters(tickets, { windowDays = 90, minDevices = 2 } = {}) {
  const since = Date.now() - windowDays * DAY;
  const groups = new Map();
  (tickets || []).forEach(ticket => {
    const created = new Date(ticket.createdAt).getTime();
    const location = ticket.location || ticket.deviceId?.location;
    const deviceId = idOf(ticket.deviceId);
    if (!location || !ticket.issueType || !deviceId || Number.isNaN(created) || created < since) return;
    const key = `${location}::${ticket.issueType}`;
    const group = groups.get(key) || { location, issueType: ticket.issueType, deviceIds: new Set(), tickets: [], since: created };
    group.deviceIds.add(deviceId);
    group.tickets.push(ticket);
    group.since = Math.min(group.since, created);
    groups.set(key, group);
  });
  return [...groups.values()]
    .filter(group => group.deviceIds.size >= minDevices)
    .map(({ deviceIds, ...group }) => ({ ...group, devices: deviceIds.size }))
    .sort((a, b) => b.devices - a.devices || b.tickets.length - a.tickets.length);
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
