import assert from 'node:assert/strict';
import { test } from 'node:test';
import { page, pageCount, pageLabel } from '../src/paginate.js';

const items = Array.from({ length: 23 }, (_, i) => `row ${i + 1}`);

test('counts pages, rounding a partial page up', () => {
  assert.equal(pageCount(23, 10), 3);
  assert.equal(pageCount(20, 10), 2);
  assert.equal(pageCount(0, 10), 0);
});

test('a full page holds pageSize rows', () => {
  assert.deepEqual(page(items, 1, 10), items.slice(0, 10));
  assert.deepEqual(page(items, 2, 10), items.slice(10, 20));
});

test('the last page holds the remainder', () => {
  assert.deepEqual(page(items, 3, 10), ['row 21', 'row 22', 'row 23']);
});

test('pages outside the range are empty', () => {
  assert.deepEqual(page(items, 0, 10), []);
  assert.deepEqual(page(items, 4, 10), []);
});

test('labels the rows a page shows', () => {
  assert.equal(pageLabel(3, 10, 23), '21–23 of 23');
});
