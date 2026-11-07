import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens, fitsContext } from '../src/runners/local.js';

const config = { ollama: { model: 'qwen3:8b', contextTokens: 8192 } };

test('estimateTokens is a rough character-based count', () => {
  assert.equal(estimateTokens('x'.repeat(400)), 100);
  assert.equal(estimateTokens(''), 0);
});

test('a prompt that fits leaves room for the answer', () => {
  const fit = fitsContext(config, { system: 'x'.repeat(400), prompt: 'y'.repeat(400) });
  assert.equal(fit.ok, true);
  assert.equal(fit.needed, 100 + 100 + 1024);
});

test('two fetched wikipedia pages do not fit an 8k window', () => {
  // Measured live: 14,048 + 43,330 chars, the second truncated to 40,000.
  const fit = fitsContext(config, { system: '', prompt: 'x'.repeat(54_048) });
  assert.equal(fit.ok, false);
  assert.ok(fit.needed > 13_000, `needed ${fit.needed}`);
});

test('the reserve means a prompt that exactly fills the window is still refused', () => {
  const fit = fitsContext(config, { prompt: 'x'.repeat(8192 * 4) });
  assert.equal(fit.ok, false, 'no room left to answer in');
});

test('raising the window changes the verdict, not the arithmetic', () => {
  const big = { ollama: { ...config.ollama, contextTokens: 32_768 } };
  assert.equal(fitsContext(big, { prompt: 'x'.repeat(54_048) }).ok, true);
});
