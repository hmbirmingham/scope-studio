import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParseError, parseOrder } from '../src/parse.js';
import { lineCents, volumeRate } from '../src/price.js';
import { bandCents } from '../src/shipping.js';
import { quote } from '../src/quote.js';
import { validateOrder } from '../src/validate.js';

test('parses an export, skipping blanks and comments', () => {
  assert.deepEqual(parseOrder('# export\nA-1, 2, 1000, 300\n\nB-2,1,500,50\n'), [
    { sku: 'A-1', quantity: 2, unitCents: 1000, gramsEach: 300 },
    { sku: 'B-2', quantity: 1, unitCents: 500, gramsEach: 50 },
  ]);
  assert.throws(() => parseOrder('A-1,2,10'), ParseError);
  assert.throws(() => parseOrder('a-1,2,10,5'), /not a SKU/);
});

test('validation rejects empty, duplicate and zero lines', () => {
  assert.deepEqual(validateOrder([]), ['the order is empty']);
  assert.equal(validateOrder([{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }]).length, 1);
  assert.equal(validateOrder([{ sku: 'A', quantity: 0 }]).length, 1);
});

test('volume discounts by quantity', () => {
  assert.equal(volumeRate(9), 0);
  assert.equal(volumeRate(10), 0.05);
  assert.equal(volumeRate(100), 0.15);
  assert.equal(lineCents({ unitCents: 1000, quantity: 10 }), 9500);
});

test('shipping bands are in kilograms', () => {
  assert.equal(bandCents(0.8), 495);
  assert.equal(bandCents(3), 895);
  assert.equal(bandCents(21.5), 1895 + 2 * 120);
});

test('a light order ships in the first band', () => {
  // 2 × 300 g + 50 g + 250 g packaging = 0.9 kg
  const result = quote('A-1,2,1000,300\nB-2,1,500,50');
  assert.equal(result.shipping, 495);
  assert.equal(result.total, 2500 + 495);
  assert.equal(result.summary, '2 lines: $25.00 + $4.95 shipping = $29.95');
});

test('a heavier order ships in its weight band', () => {
  // 4 × 1000 g + 250 g = 4.25 kg
  assert.equal(quote('C-3,4,2000,1000').shipping, 895);
});

test('large orders ship free', () => {
  assert.equal(quote('D-4,20,1000,5000').shipping, 0);
});

test('an invalid order is not quoted', () => {
  assert.deepEqual(quote('A-1,0,100,10'), { ok: false, problems: ['A-1 has quantity 0'] });
});
