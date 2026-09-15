import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequestUnderstanding, understandDeterministicResult } from './requestExtractor.js';

test('recognizes a troubleshooting result in English and Tamil without inventing request data', () => {
  assert.equal(normalizeRequestUnderstanding(null, "Still not working.").workflowSignal, 'failed');
  assert.equal(normalizeRequestUnderstanding(null, 'Yes, it is working now.').workflowSignal, 'resolved');
  assert.equal(normalizeRequestUnderstanding(null, 'இன்னும் வேலை செய்யவில்லை.').workflowSignal, 'failed');
  assert.equal(normalizeRequestUnderstanding(null, 'சரி ஆயிடுச்சு.').workflowSignal, 'resolved');
});

test('does not treat a normal first issue report as a service escalation', () => {
  const understanding = normalizeRequestUnderstanding(null, 'My phone is still not charging.');
  assert.equal(understanding.workflowSignal, 'failed');
  assert.equal(understanding.issueType, 'Charging');
});

test('extracts a normal initial issue locally while Gemini remains responsible for its reply', () => {
  const understanding = understandDeterministicResult('My iPhone is not charging.');
  assert.equal(understanding.issueType, 'Charging');
  assert.equal(understanding.workflowSignal, 'unknown');
});

test('does not let a model infer an immediate service exception from a normal issue', () => {
  const understanding = normalizeRequestUnderstanding({ workflowSignal: 'explicit_service', issueType: 'Charging' }, 'My iPhone is not charging after I used a different cable.');
  assert.equal(understanding.workflowSignal, 'unknown');
  assert.equal(understanding.issueType, 'Charging');
});

test('classifies an explicit failed troubleshooting result without a provider call', () => {
  assert.equal(understandDeterministicResult('The issue is not resolved.').workflowSignal, 'failed');
});
