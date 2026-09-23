// Shared formatting and status helpers used by both portals.

const dateFormatter = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value, fallback = '—') {
  const date = toDate(value);
  return date ? dateFormatter.format(date) : fallback;
}

export function formatDateTime(value, fallback = '—') {
  const date = toDate(value);
  return date ? `${dateFormatter.format(date)} • ${timeFormatter.format(date)}` : fallback;
}

export function formatTime(value, fallback = '—') {
  const date = toDate(value);
  return date ? timeFormatter.format(date) : fallback;
}

export function formatRelative(value) {
  const date = toDate(value);
  if (!date) return '';
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(date);
}

export function todayLabel() {
  return new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
}

export function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function initials(name = '') {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || '—';
}

export function dayGroup(value) {
  const date = toDate(value);
  if (!date) return 'Earlier';
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (date >= start) return 'Today';
  const yesterday = new Date(start.getTime() - 86400000);
  if (date >= yesterday) return 'Yesterday';
  return 'Earlier';
}

// Maps a backend status string to a restrained visual tone. Text is always
// rendered alongside the tone so status never relies on colour alone.
const tones = {
  success: ['active', 'completed', 'closed', 'resolved', 'healthy', 'covered', 'assigned', 'available', 'in use', 'connected', 'published'],
  info: ['open', 'engineer assigned', 'engineer accepted', 'in progress', 'internal', 'medium', 'service request', 'service'],
  warning: ['at risk', 'waiting for parts', 'expiring soon', 'high', 'unassigned', 'pending', 'busy', 'under service', 'sla approaching', 'sla at risk'],
  critical: ['sla breached', 'escalated', 'critical', 'expired', 'not covered', 'breached', 'critical sla breach', 'high priority sla breach', 'sla breached'],
};

export function statusTone(value) {
  const key = String(value || '').trim().toLowerCase();
  for (const [tone, values] of Object.entries(tones)) if (values.includes(key)) return tone;
  return 'neutral';
}

export function slaLabel(ticket) {
  if (!ticket) return 'Healthy';
  if (ticket.slaStatus) return ticket.slaStatus;
  if (ticket.escalationStatus && ticket.escalationStatus !== 'Not Escalated') return ticket.escalationStatus;
  return 'Healthy';
}

export function isoDay(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : '';
}

export function monthlyVolume(items, dateKey = 'createdAt') {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const year = new Date().getFullYear();
  const counts = new Array(12).fill(0);
  items.forEach(item => {
    const date = toDate(item[dateKey]);
    if (date && date.getFullYear() === year) counts[date.getMonth()] += 1;
  });
  return months.map((month, index) => ({ month, tickets: counts[index] }));
}

export function readSessionUser() {
  try { return JSON.parse(localStorage.getItem('iplanet_user') || localStorage.getItem('iplanet_service_user') || 'null') || {}; } catch { return {}; }
}

export function friendlyError(error, fallback = 'Something went wrong. Please try again.') {
  const message = error?.message || '';
  if (/\b429\b|RESOURCE_EXHAUSTED|quota exceeded|rate.?limit/i.test(message)) return 'The service is receiving too many requests right now. Please try again in a minute.';
  // Hide low-level network/stack messages and raw payloads; keep short backend validation messages.
  if (!message || message.length > 180 || /[{}[\]]/.test(message) || /failed to fetch|networkerror|unexpected token|stack|at \w+ \(/i.test(message)) return fallback;
  return message;
}
