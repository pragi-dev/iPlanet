// Pure calendar and status rules for proactive service. Dates are handled as
// calendar days ({ y, m, d }) in the business time zone, never as strings or
// local Date arithmetic, so month lengths, leap years and time zones are exact.
import { proactiveConfig } from './serviceConfig.js';

const DAY_MS = 86400000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Calendar day of a value in `timeZone`. A 'YYYY-MM-DD' string is taken as-is.
export function calendarDate(value, timeZone = proactiveConfig.timeZone) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const match = ISO_DAY.exec(value);
    if (match) {
      const cal = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
      return isoDay(cal) === value ? cal : null; // rejects 2026-02-30
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { y: parts.year, m: parts.month, d: parts.day };
}

const toUtc = ({ y, m, d }) => Date.UTC(y, m - 1, d);
export const isoDay = cal => (cal ? new Date(toUtc(cal)).toISOString().slice(0, 10) : null);
export const today = (now = new Date(), timeZone = proactiveConfig.timeZone) => calendarDate(now, timeZone);
export const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
export const addDays = (cal, days) => calendarDate(new Date(toUtc(cal) + days * DAY_MS).toISOString().slice(0, 10));

// Adds whole months, clamping to the last day of a shorter month
// (31 Jan + 1 month = 28/29 Feb; 29 Feb 2028 + 12 months = 28 Feb 2029).
export function addMonths(cal, months) {
  const total = cal.y * 12 + (cal.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(cal.d, lastDay) };
}

export function intervalMonths(device, config = proactiveConfig) {
  const own = Number(device?.serviceIntervalMonths);
  return Number.isInteger(own) && own > 0 && own <= 60 ? own : config.defaultIntervalMonths;
}

// Next recommended service date, by priority:
//   1. an explicit nextServiceDate on the device
//   2. lastServiceDate + interval
//   3. installationDate, else purchaseDate, + interval
// Past-dated history only: a last-service or purchase date later than today is
// treated as invalid data and ignored (and reported), never trusted. Returns
// { date: null } when there is not enough information — no date is invented.
export function nextServiceDate(device, { now = new Date(), config = proactiveConfig } = {}) {
  const current = today(now, config.timeZone);
  const months = intervalMonths(device, config);
  const issues = [];
  const history = (field, label) => {
    const cal = calendarDate(device?.[field], config.timeZone);
    if (!cal) return null;
    if (daysBetween(cal, current) < 0) { issues.push(`${label} is in the future and was ignored`); return null; }
    return cal;
  };
  const explicit = calendarDate(device?.nextServiceDate, config.timeZone);
  if (explicit) return { date: explicit, basis: 'explicit', intervalMonths: months, issues };
  const last = history('lastServiceDate', 'Last service date');
  if (last) return { date: addMonths(last, months), basis: 'lastService', from: last, intervalMonths: months, issues };
  const installed = history('installationDate', 'Installation date');
  if (installed) return { date: addMonths(installed, months), basis: 'installation', from: installed, intervalMonths: months, issues };
  const purchased = history('purchaseDate', 'Purchase date');
  if (purchased) return { date: addMonths(purchased, months), basis: 'purchase', from: purchased, intervalMonths: months, issues };
  return { date: null, basis: null, intervalMonths: months, issues: [...issues, 'No purchase, installation or service date on record'] };
}

// 'Not Due' | 'Upcoming' | 'Due' | 'Overdue' from days until the recommended date.
export function timingStatus(daysUntil, config = proactiveConfig) {
  if (daysUntil === null || daysUntil === undefined) return null;
  if (daysUntil > config.upcomingDays) return 'Not Due';
  if (daysUntil > 0) return 'Upcoming';
  if (daysUntil >= -config.overdueGraceDays) return 'Due';
  return 'Overdue';
}

// Stages a follow-up can be in. Open means nobody has acted on it yet.
export const ACTIVE_STAGES = ['Open', 'Contacted', 'Remind Later', 'Scheduled', 'In Service'];
export const TERMINAL_STAGES = ['Completed', 'Not Required', 'Superseded'];

// What the portals show for a follow-up, and whether the service team needs to
// act on it now. A reminder that has come due is actionable again.
export function displayStatus({ stage = 'Open', timing, followUpDate }, current) {
  if (stage === 'Open') return { status: timing === 'Not Due' ? 'Upcoming' : timing, actionable: timing !== 'Not Due' };
  if (stage === 'Remind Later') {
    const due = followUpDate && calendarDate(followUpDate) && daysBetween(calendarDate(followUpDate), current) >= 0;
    return { status: due ? 'Reminder Due' : 'Remind Later', actionable: Boolean(due) };
  }
  return { status: stage, actionable: false };
}

export const CONTACT_METHODS = ['Phone', 'Email', 'In person', 'Portal message'];
export const CONTACT_OUTCOMES = ['Contacted', 'Customer Interested', 'Customer Not Interested', 'Customer Requested Later', 'Customer Unavailable', 'Service Scheduled'];
export const NOT_REQUIRED_REASONS = ['Device not in use', 'Recently serviced externally', 'Service not required', 'Device being replaced', 'Other'];

// Validates a 'YYYY-MM-DD' that must be today or later (or strictly later).
export function futureDay(value, { now = new Date(), allowToday = true, config = proactiveConfig } = {}) {
  const cal = typeof value === 'string' ? calendarDate(value) : null;
  if (!cal) return null;
  const diff = daysBetween(today(now, config.timeZone), cal);
  return diff > 0 || (allowToday && diff === 0) ? isoDay(cal) : null;
}
