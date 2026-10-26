import { isActiveTicket, slaLabel, slaRisk } from '../ui';

// Report figures for a set of requests, shared by the Reports page and its PDF download
// so both always show the same numbers.
export function groupBy(items, pick) {
  return Object.entries(items.reduce((result, item) => { const key = pick(item) || 'Other'; result[key] = (result[key] || 0) + 1; return result; }, {})).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

const closedAt = ticket => ticket.closedAt || ticket.updatedAt;
const breached = ticket => ['SLA Breached', 'Escalated'].includes(ticket.escalationStatus) || slaLabel(ticket) === 'SLA Breached';

export function summarise(tickets) {
  const closed = tickets.filter(ticket => ticket.status === 'Closed' && ticket.createdAt && closedAt(ticket));
  const resolved = tickets.filter(ticket => ['Completed', 'Closed'].includes(ticket.status));
  const onTarget = resolved.filter(ticket => !breached(ticket)).length;
  return {
    total: tickets.length,
    open: tickets.filter(isActiveTicket).length,
    closed: tickets.filter(ticket => ticket.status === 'Closed').length,
    closedCount: closed.length,
    avgDays: closed.length ? closed.reduce((sum, ticket) => sum + (new Date(closedAt(ticket)) - new Date(ticket.createdAt)), 0) / closed.length / 86400000 : null,
    resolvedCount: resolved.length,
    onTargetPercent: resolved.length ? Math.round((onTarget / resolved.length) * 100) : null,
    byStatus: groupBy(tickets, ticket => ticket.status),
    sla: groupBy(tickets, ticket => {
      if (isActiveTicket(ticket)) return { breached: 'Open · breached or escalated', escalated: 'Open · breached or escalated', risk: 'Open · at risk' }[slaRisk(ticket)] || 'Open · within SLA';
      if (resolved.includes(ticket)) return breached(ticket) ? 'Resolved · target missed' : 'Resolved · on target';
      return 'Other';
    }),
    byType: groupBy(tickets, ticket => ticket.category || 'Service'),
    byIssue: groupBy(tickets.filter(ticket => (ticket.category || 'Service') === 'Service'), ticket => ticket.issueType),
    byLocation: groupBy(tickets, ticket => ticket.location),
    byDeviceType: groupBy(tickets, ticket => ticket.deviceId?.deviceType),
  };
}

export const coverage = devices => ({
  warranty: groupBy(devices, device => device.warrantyStatus || 'Not recorded'),
  amc: groupBy(devices, device => device.amcStatus || 'Not recorded'),
});

// Reporting periods are picked on a calendar: a year, a month, a day, or a custom range of
// days. Each period has a key, a title and a [start, end) range.
export const PERIOD_KINDS = [{ value: 'year', label: 'Yearly' }, { value: 'month', label: 'Monthly' }, { value: 'day', label: 'Daily' }, { value: 'custom', label: 'Custom range' }];
// A custom range longer than this is charted per month rather than per day.
const DAILY_TREND_LIMIT = 31;
const monthLabel = date => date.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
const dayLabel = (date, options) => date.toLocaleString('en-IN', { day: 'numeric', month: 'short', ...options });
const pad = value => String(value).padStart(2, '0');
const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const parseDateKey = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
};

// The latest date that can be picked.
export const latestDate = (now = new Date()) => dateKey(startOfDay(now));

// The period of the given kind that contains the picked date. A missing date, or one after
// the latest allowed date, falls back to the latest. The current month and year are shown
// so far, marked as such.
export function periodForDate(kind, value, now = new Date()) {
  const latest = parseDateKey(latestDate(now));
  const picked = parseDateKey(value);
  const date = picked && picked <= latest ? picked : latest;
  if (kind === 'year') {
    const year = date.getFullYear();
    return { key: String(year), value: dateKey(date), title: `${year}${year === now.getFullYear() ? ' (so far)' : ''}`, start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
  }
  if (kind === 'month') {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const current = start.getFullYear() === now.getFullYear() && start.getMonth() === now.getMonth();
    return { key: `${start.getFullYear()}-${pad(start.getMonth() + 1)}`, value: dateKey(date), title: `${monthLabel(start)}${current ? ' (so far)' : ''}`, start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
  }
  return { key: dateKey(date), value: dateKey(date), title: `${date.toLocaleString('en-IN', { weekday: 'short' })} ${dayLabel(date, { year: 'numeric' })}`, start: date, end: addDays(date, 1) };
}

// The days from `from` to `to`, inclusive. Dates are swapped if given the wrong way round;
// missing or future dates fall back to the last 7 days up to today.
export function rangePeriod(from, to, now = new Date()) {
  const latest = parseDateKey(latestDate(now));
  const clamp = value => { const date = parseDateKey(value); return date && date <= latest ? date : null; };
  let end = clamp(to) || latest;
  let start = clamp(from) || addDays(end, -6);
  if (start > end) [start, end] = [end, start];
  const title = start.getTime() === end.getTime() ? dayLabel(start, { year: 'numeric' }) : `${dayLabel(start, start.getFullYear() === end.getFullYear() ? {} : { year: 'numeric' })} – ${dayLabel(end, { year: 'numeric' })}`;
  return { key: `${dateKey(start)}-to-${dateKey(end)}`, from: dateKey(start), to: dateKey(end), title, start, end: addDays(end, 1) };
}

// Requests raised over the period, in steps that suit its length.
export function trend(tickets, kind, period) {
  const buckets = [];
  if (kind === 'year') {
    for (let month = 0; month < 12; month += 1) { const start = new Date(period.start.getFullYear(), month, 1); buckets.push({ name: start.toLocaleString('en-IN', { month: 'short' }), start, end: new Date(start.getFullYear(), month + 1, 1) }); }
  } else if (kind === 'day') {
    for (let hour = 0; hour < 24; hour += 1) { const start = new Date(period.start.getFullYear(), period.start.getMonth(), period.start.getDate(), hour); buckets.push({ name: pad(hour), start, end: new Date(start.getTime() + 3600000) }); }
  } else if (kind === 'custom' && (period.end - period.start) / 86400000 > DAILY_TREND_LIMIT) {
    for (let month = new Date(period.start.getFullYear(), period.start.getMonth(), 1); month < period.end; month = new Date(month.getFullYear(), month.getMonth() + 1, 1)) {
      buckets.push({ name: month.toLocaleString('en-IN', { month: 'short', year: '2-digit' }), start: month < period.start ? period.start : month, end: new Date(Math.min(new Date(month.getFullYear(), month.getMonth() + 1, 1), period.end)) });
    }
  } else {
    for (let day = period.start; day < period.end; day = addDays(day, 1)) buckets.push({ name: kind === 'custom' && period.start.getMonth() !== addDays(period.end, -1).getMonth() ? `${day.getDate()}/${day.getMonth() + 1}` : String(day.getDate()), start: day, end: addDays(day, 1) });
  }
  const step = kind === 'custom' ? ((period.end - period.start) / 86400000 > DAILY_TREND_LIMIT ? 'month' : 'day') : { year: 'month', month: 'day', day: 'hour' }[kind];
  return { step, data: buckets.map(bucket => ({ name: bucket.name, requests: raisedIn(tickets, bucket).length })) };
}

export const raisedIn = (tickets, { start, end }) => tickets.filter(ticket => { const created = new Date(ticket.createdAt); return created >= start && created < end; });
export const closedIn = (tickets, { start, end }) => tickets.filter(ticket => { if (ticket.status !== 'Closed') return false; const closed = new Date(closedAt(ticket)); return closed >= start && closed < end; });
export { closedAt };
