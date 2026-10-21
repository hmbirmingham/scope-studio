import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoiceTotal, lineTotal, subtotal, taxCents } from '../src/invoice.js';

const lines = [
  { unitCents: 1250, quantity: 2 },
  { unitCents: 999, quantity: 3, discountRate: 0.1 },
];

test('a line applies its discount and rounds once', () => {
  assert.equal(lineTotal(lines[0]), 2500);
  assert.equal(lineTotal(lines[1]), 2697);
});

test('the subtotal sums the lines', () => {
  assert.equal(subtotal(lines), 5197);
});

test('tax is a share of the subtotal', () => {
  assert.equal(taxCents(5197, 0.2), 1039);
});

test('the total adds tax to the subtotal', () => {
  assert.equal(invoiceTotal(lines, 0.2), 6236);
  assert.equal(invoiceTotal(lines, 0), 5197);
});
