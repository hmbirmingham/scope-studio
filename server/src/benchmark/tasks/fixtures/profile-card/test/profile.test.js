import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayName, location, profileLine } from '../src/profile.js';

test('the display name falls back to the email', () => {
  assert.equal(displayName({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }), 'Ada Lovelace');
  assert.equal(displayName({ email: 'anon@example.com' }), 'anon@example.com');
});

test('a full address shows city and country', () => {
  assert.equal(location({ address: { city: 'Leeds', country: 'UK' } }), 'Leeds, UK');
});

test('an empty address reads as unknown', () => {
  assert.equal(location({ address: {} }), 'Location unknown');
});

test('a member with no address at all reads as unknown', () => {
  assert.equal(location({ email: 'early@example.com' }), 'Location unknown');
  assert.equal(location({ email: 'early@example.com', address: null }), 'Location unknown');
});

test('the profile line joins both', () => {
  assert.equal(profileLine({ firstName: 'Grace', email: 'g@example.com' }), 'Grace · Location unknown');
});
