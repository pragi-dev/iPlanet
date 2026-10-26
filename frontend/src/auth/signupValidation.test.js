import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordChecks, validateSignup } from './signupValidation.js';

const valid = { name: 'Priya Sharma', email: 'priya@acme.example', phone: '+91 98765 43210', organization: 'Acme Industries', gstNumber: '27AAPFU0939F1ZV', password: 'Str0ngPass', confirmPassword: 'Str0ngPass' };

test('accepts a complete form; GSTIN may be lower case or spaced', () => {
  assert.deepEqual(validateSignup(valid), {});
  assert.deepEqual(validateSignup({ ...valid, gstNumber: '27aapfu 0939f1zv' }), {});
});

test('requires a mobile number and GSTIN', () => {
  assert.deepEqual(Object.keys(validateSignup({ ...valid, phone: '', gstNumber: '' })).sort(), ['gstNumber', 'phone']);
});

test('rejects each invalid field', () => {
  const errors = validateSignup({ name: ' ', email: 'priya@', phone: 'call me', organization: '', gstNumber: 'not-a-gst', password: '', confirmPassword: '' });
  assert.deepEqual(Object.keys(errors).sort(), ['email', 'gstNumber', 'name', 'organization', 'password', 'phone']);
});

test('checks the password policy before the confirmation', () => {
  assert.ok(validateSignup({ ...valid, password: 'weak', confirmPassword: 'weak' }).password);
  assert.equal(validateSignup({ ...valid, confirmPassword: 'Str0ngPas' }).confirmPassword, 'Passwords do not match.');
  assert.deepEqual(passwordChecks('Str0ngPass').map(check => check.met), [true, true, true]);
  assert.deepEqual(passwordChecks('lowercase').map(check => check.met), [true, false, false]);
});
