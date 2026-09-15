import test from 'node:test';
import assert from 'node:assert/strict';
import { indiaToday, resolveServiceDateIntent } from './serviceDate.js';

// 2026-09-15 10:00 in India: use a fixed instant to make date-only logic deterministic.
const now = new Date('2026-09-15T04:30:00.000Z');

test('resolves relative dates in Asia/Kolkata', () => {
  assert.equal(indiaToday(now), '2026-09-15');
  assert.equal(resolveServiceDateIntent('tomorrow', now).date, '2026-09-16');
  assert.equal(resolveServiceDateIntent('next Monday', now).date, '2026-09-21');
});

test('keeps the India calendar date across a UTC day boundary', () => {
  // 00:15 on 15 September in India is still 14 September UTC.
  assert.equal(indiaToday(new Date('2026-09-14T18:45:00.000Z')), '2026-09-15');
});

test('resolves named dates without accepting an invented historical date', () => {
  assert.equal(resolveServiceDateIntent('September 20', now).date, '2026-09-20');
  assert.equal(resolveServiceDateIntent('January 5', now).date, '2027-01-05');
  assert.equal(resolveServiceDateIntent('next week', now).ambiguous, true);
  assert.equal(resolveServiceDateIntent('2023-01-01', now).date, null);
});
