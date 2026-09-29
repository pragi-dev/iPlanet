import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProactiveConfig } from './serviceConfig.js';
import { addMonths, calendarDate, daysBetween, displayStatus, futureDay, isoDay, nextServiceDate, timingStatus } from './serviceStatus.js';

const config = loadProactiveConfig({});
const day = value => calendarDate(value, config.timeZone);
const at = iso => new Date(`${iso}T06:00:00Z`); // midday in India

test('adds months with month-length clamping, leap years and year changes', () => {
  assert.equal(isoDay(addMonths(day('2026-01-10'), 6)), '2026-07-10');
  assert.equal(isoDay(addMonths(day('2026-08-31'), 6)), '2027-02-28');
  assert.equal(isoDay(addMonths(day('2027-08-31'), 6)), '2028-02-29');
  assert.equal(isoDay(addMonths(day('2028-02-29'), 12)), '2029-02-28');
  assert.equal(isoDay(addMonths(day('2026-10-15'), 6)), '2027-04-15');
  assert.equal(isoDay(addMonths(day('2026-03-31'), 1)), '2026-04-30');
});

test('reads stored instants as calendar days in the business time zone', () => {
  // 20:00 UTC on 9 Jan is 01:30 on 10 Jan in India.
  assert.equal(isoDay(calendarDate(new Date('2026-01-09T20:00:00Z'), 'Asia/Kolkata')), '2026-01-10');
  assert.equal(isoDay(calendarDate(new Date('2026-01-10T00:00:00Z'), 'Asia/Kolkata')), '2026-01-10');
  assert.equal(calendarDate('2026-02-30'), null);
  assert.equal(calendarDate('not a date'), null);
  assert.equal(daysBetween(day('2026-12-31'), day('2027-01-01')), 1);
  assert.equal(daysBetween(day('2028-02-28'), day('2028-03-01')), 2);
});

test('next service date follows the documented priority', () => {
  const now = at('2026-09-29');
  const purchaseOnly = nextServiceDate({ purchaseDate: new Date('2026-01-10T00:00:00Z') }, { now, config });
  assert.deepEqual([isoDay(purchaseOnly.date), purchaseOnly.basis], ['2026-07-10', 'purchase']);
  const installed = nextServiceDate({ purchaseDate: new Date('2026-01-10'), installationDate: new Date('2026-02-01') }, { now, config });
  assert.deepEqual([isoDay(installed.date), installed.basis], ['2026-08-01', 'installation']);
  const serviced = nextServiceDate({ purchaseDate: new Date('2026-01-10'), lastServiceDate: new Date('2026-07-20') }, { now, config });
  assert.deepEqual([isoDay(serviced.date), serviced.basis], ['2027-01-20', 'lastService']);
  const explicit = nextServiceDate({ purchaseDate: new Date('2026-01-10'), lastServiceDate: new Date('2026-07-20'), nextServiceDate: new Date('2026-11-05') }, { now, config });
  assert.deepEqual([isoDay(explicit.date), explicit.basis], ['2026-11-05', 'explicit']);
  const ownInterval = nextServiceDate({ purchaseDate: new Date('2026-01-10'), serviceIntervalMonths: 3 }, { now, config });
  assert.equal(isoDay(ownInterval.date), '2026-04-10');
});

test('never invents a date, and ignores future history dates', () => {
  const now = at('2026-09-29');
  const empty = nextServiceDate({}, { now, config });
  assert.equal(empty.date, null);
  assert.ok(empty.issues.length > 0);
  const futureLast = nextServiceDate({ purchaseDate: new Date('2026-01-10'), lastServiceDate: new Date('2194-03-12') }, { now, config });
  assert.equal(futureLast.basis, 'purchase');
  assert.match(futureLast.issues[0], /Last service date is in the future/);
  assert.equal(nextServiceDate({ purchaseDate: new Date('2026-11-01') }, { now, config }).date, null);
});

test('timing thresholds come from configuration', () => {
  assert.equal(timingStatus(31, config), 'Not Due');
  assert.equal(timingStatus(30, config), 'Upcoming');
  assert.equal(timingStatus(1, config), 'Upcoming');
  assert.equal(timingStatus(0, config), 'Due');
  assert.equal(timingStatus(-14, config), 'Due');
  assert.equal(timingStatus(-15, config), 'Overdue');
  const custom = loadProactiveConfig({ SERVICE_UPCOMING_DAYS: '7', SERVICE_OVERDUE_GRACE_DAYS: '3' });
  assert.equal(timingStatus(8, custom), 'Not Due');
  assert.equal(timingStatus(-4, custom), 'Overdue');
  assert.equal(loadProactiveConfig({ SERVICE_UPCOMING_DAYS: 'abc' }).upcomingDays, 30);
});

test('reminders become actionable again on their date', () => {
  const current = day('2026-10-15');
  assert.deepEqual(displayStatus({ stage: 'Remind Later', followUpDate: '2026-10-16' }, current), { status: 'Remind Later', actionable: false });
  assert.deepEqual(displayStatus({ stage: 'Remind Later', followUpDate: '2026-10-15' }, current), { status: 'Reminder Due', actionable: true });
  assert.deepEqual(displayStatus({ stage: 'Open', timing: 'Overdue' }, current), { status: 'Overdue', actionable: true });
  assert.deepEqual(displayStatus({ stage: 'Scheduled', timing: 'Due' }, current), { status: 'Scheduled', actionable: false });
});

test('follow-up and schedule dates must not be in the past', () => {
  const now = at('2026-09-29');
  assert.equal(futureDay('2026-09-29', { now, allowToday: true, config }), '2026-09-29');
  assert.equal(futureDay('2026-09-29', { now, allowToday: false, config }), null);
  assert.equal(futureDay('2026-09-28', { now, config }), null);
  assert.equal(futureDay('2026-10-15', { now, allowToday: false, config }), '2026-10-15');
  assert.equal(futureDay('15/10/2026', { now, config }), null);
});
