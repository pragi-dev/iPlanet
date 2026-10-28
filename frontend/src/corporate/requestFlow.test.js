// Steps, validation and submitted body of the Raise Request wizard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUYBACK_EWASTE, detailsErrors, nextStep, previousStep, requestPayload, requestSteps, stepLabels, stepValid } from './requestFlow.js';

const TODAY = '2026-10-27';
const service = { category: 'Service', issueType: 'Battery', description: 'Battery drains fast', location: 'Chennai', preferredServiceDate: TODAY, priority: 'High', deviceId: 'dev-1', deviceCount: '' };
const onSite = category => ({ ...service, category, deviceId: '', deviceCount: '25', preferredServiceDate: '2026-11-05' });

test('a Service request identifies its device in Request details, then goes to Evidence and Review', () => {
  assert.deepEqual(stepLabels('Service'), ['Request details', 'Evidence', 'Review', 'Submit']);
  assert.equal(requestSteps('Service')[0], 'details');
  assert.equal(nextStep('details', 'Service'), 'evidence');
  assert.equal(nextStep('evidence', 'Service'), 'review');
  assert.equal(nextStep('review', 'Service'), 'review');
});

for (const category of ['Health Camp', BUYBACK_EWASTE]) {
  test(`${category} goes from Request details straight to Review`, () => {
    assert.deepEqual(stepLabels(category), ['Request details', 'Review', 'Submit']);
    assert.equal(nextStep('details', category), 'review');
    assert.equal(previousStep('review', category), 'details');
  });

  test(`${category} needs no device or serial number`, () => {
    const form = onSite(category);
    assert.equal(stepValid('details', form, TODAY), true);
    assert.equal(stepValid('review', form, TODAY), true, 'can submit without a device');
  });

  test(`${category} submits no device, photos step or recommendation link`, () => {
    const body = requestPayload({ ...onSite(category), deviceId: 'dev-left-over' }, { serviceFollowUpId: 'fu-1' });
    assert.equal(body.deviceId, undefined);
    assert.equal(body.serviceFollowUpId, undefined);
    assert.equal(body.deviceCount, 25);
    assert.equal(body.priority, 'Low');
    assert.equal(body.issueType, category === 'Health Camp' ? 'Health Camp' : 'Other');
  });
}

test('Request details validation blocks invalid progression', () => {
  assert.deepEqual(Object.keys(detailsErrors({ ...service, description: '  ' }, TODAY)), ['description']);
  assert.equal(stepValid('details', { ...service, description: '' }, TODAY), false);
  const camp = onSite('Health Camp');
  assert.deepEqual(Object.keys(detailsErrors({ ...camp, deviceCount: '' }, TODAY)), ['deviceCount']);
  assert.deepEqual(Object.keys(detailsErrors({ ...camp, deviceCount: '0' }, TODAY)), ['deviceCount']);
  assert.deepEqual(Object.keys(detailsErrors({ ...camp, preferredServiceDate: '2026-10-30' }, TODAY)), ['preferredServiceDate'], 'Health Camp needs 4 days notice');
  assert.equal(stepValid('details', { ...onSite(BUYBACK_EWASTE), preferredServiceDate: '2026-10-29' }, TODAY), true, 'Buyback / E-Waste needs 2 days notice');
});

test('a Service request cannot leave Request details without a device, and evidence stays optional', () => {
  assert.deepEqual(Object.keys(detailsErrors({ ...service, deviceId: '' }, TODAY)), ['deviceId']);
  assert.equal(stepValid('details', { ...service, deviceId: '' }, TODAY), false);
  assert.equal(stepValid('details', service, TODAY), true);
  assert.equal(stepValid('evidence', service, TODAY), true);
  assert.equal(stepValid('review', { ...service, deviceId: '' }, TODAY), false);
  assert.equal(stepValid('review', service, TODAY), true);
});

test('a Service request submits its device and recommendation link', () => {
  const body = requestPayload(service, { serviceFollowUpId: 'fu-1' });
  assert.equal(body.deviceId, 'dev-1');
  assert.equal(body.serviceFollowUpId, 'fu-1');
  assert.equal(body.priority, 'High');
  assert.equal('deviceCount' in body, false);
});

test('changing the request type recalculates the steps and keeps the form', () => {
  const form = { ...service };
  assert.equal(nextStep('details', form.category), 'evidence');
  const camp = { ...form, category: 'Health Camp', deviceCount: '10', preferredServiceDate: '2026-11-05' };
  assert.equal(nextStep('details', camp.category), 'review');
  assert.equal(requestPayload(camp).deviceId, undefined);
  const back = { ...camp, category: 'Service' };
  assert.equal(nextStep('details', back.category), 'evidence');
  assert.equal(stepValid('review', back, TODAY), true, 'the device chosen earlier is still selected');
});

test('Back goes to the right step on both paths', () => {
  assert.equal(previousStep('review', 'Service'), 'evidence');
  assert.equal(previousStep('evidence', 'Service'), 'details');
  assert.equal(previousStep('details', 'Service'), 'details');
  assert.equal(previousStep('review', 'Health Camp'), 'details');
});
