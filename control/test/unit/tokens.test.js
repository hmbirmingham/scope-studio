import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, looksLikeDeviceToken, newDeviceToken } from '../../src/auth/tokens.js';

test('device tokens are prefixed, 256-bit and never repeat', () => {
  const tokens = new Set(Array.from({ length: 200 }, newDeviceToken));
  assert.equal(tokens.size, 200);
  for (const token of tokens) assert.ok(looksLikeDeviceToken(token), token);
});

test('the stored hash is stable and does not contain the token', () => {
  const token = newDeviceToken();
  assert.equal(hashToken(token), hashToken(token));
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
  assert.ok(!hashToken(token).includes(token.slice(4)));
});

test('malformed values are not tokens', () => {
  for (const value of [undefined, '', 'sst_short', 'Bearer sst_x', 'sk-ant-api03-abc', `sst_${'a'.repeat(44)}`]) {
    assert.equal(looksLikeDeviceToken(value), false, String(value));
  }
});
