// Rules for requests raised by a corporate admin: Service requests need a device, Health Camp
// and Buyback / E-Waste requests are for a batch of devices and need none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketRequestCheck } from './ticketRequests.js';

const TODAY = '2026-10-27';
const DEVICE_ID = '65a1b2c3d4e5f6a7b8c9d0e1';
const service = { category: 'Service', issueType: 'Battery', description: 'Battery drains fast', priority: 'Medium', deviceId: DEVICE_ID };

test('a Service request needs a valid device ID', () => {
  assert.deepEqual(ticketRequestCheck(service, TODAY), { deviceId: DEVICE_ID });
  for (const deviceId of [undefined, '', null, 'not-an-id', { $ne: null }]) assert.match(ticketRequestCheck({ ...service, deviceId }, TODAY).error, /device selection is required/);
});

test('unknown and legacy request types still need a device', () => {
  for (const category of [undefined, 'Repair', 'Buyback', 'E-Waste']) assert.match(ticketRequestCheck({ ...service, category, deviceId: undefined }, TODAY).error, /device selection is required/);
});

for (const [category, earliest] of [['Health Camp', '2026-10-31'], ['Buyback / E-Waste', '2026-10-29']]) {
  const onSite = { category, description: 'Quarterly check', deviceCount: 25, preferredServiceDate: earliest };

  test(`${category} needs no device or serial number`, () => {
    assert.deepEqual(ticketRequestCheck(onSite, TODAY), { deviceId: null });
  });

  test(`${category} ignores a device ID instead of linking it`, () => {
    assert.deepEqual(ticketRequestCheck({ ...onSite, deviceId: DEVICE_ID }, TODAY), { deviceId: null });
  });

  test(`${category} still needs a device count and advance notice`, () => {
    for (const deviceCount of [undefined, '', 0, 1001, 2.5]) assert.match(ticketRequestCheck({ ...onSite, deviceCount }, TODAY).error, /number of devices/);
    assert.match(ticketRequestCheck({ ...onSite, preferredServiceDate: TODAY }, TODAY).error, new RegExp(`on or after ${earliest}`));
    assert.match(ticketRequestCheck({ ...onSite, preferredServiceDate: undefined }, TODAY).error, /on or after/);
  });

  test(`${category} cannot be linked to a service recommendation`, () => {
    assert.match(ticketRequestCheck({ ...onSite, serviceFollowUpId: DEVICE_ID }, TODAY).error, /only be raised as a Service request/);
  });
}
