import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/core/chunk.js';

test('a heading starts a new chunk and is carried as metadata', () => {
  const chunks = chunkText('## Alpha\nfirst body line\n\n## Beta\nsecond body line');
  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((c) => c.heading),
    ['Alpha', 'Beta']
  );
  assert.match(chunks[0].text, /first body line/);
  assert.doesNotMatch(chunks[0].text, /Beta/);
});

test('a heading with nothing under it does not become a chunk of its own', () => {
  const chunks = chunkText(['## A', 'x '.repeat(400), 'y '.repeat(400)].join('\n'), { targetTokens: 150 });
  // The first chunk holds the heading AND body, not the heading alone — a
  // heading-only chunk would spend a budget slot on a label.
  assert.match(chunks[0].text, /^## A\nx x/);
  assert.ok(chunks.length >= 2);
});

test('a continuation chunk adds no synthetic text to the quotable body', () => {
  const chunks = chunkText(['## A', 'x '.repeat(400), 'y '.repeat(400)].join('\n'), { targetTokens: 150 });
  const continuation = chunks[1];
  // Grounding checks quotes against chunk text, so anything injected here would
  // become quotable material the source never contained.
  assert.equal(continuation.heading, 'A');
  assert.doesNotMatch(continuation.text, /continued|## A/);
});

test('lines are never split, even when one line exceeds the target', () => {
  const long = 'word '.repeat(500).trim();
  const chunks = chunkText(long, { targetTokens: 100 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, long);
});

test('single-newline paragraphs still break, so an HTML section is not one chunk', () => {
  // htmlToText emits one newline per paragraph, not a blank line. A chunker
  // that only broke on blank lines would return a single oversized chunk.
  const text = Array.from({ length: 20 }, (_, i) => `paragraph ${i} ${'w '.repeat(60)}`).join('\n');
  const chunks = chunkText(text, { targetTokens: 200 });
  assert.ok(chunks.length > 3, `expected several chunks, got ${chunks.length}`);
  assert.ok(chunks.every((c) => c.tokens <= 400));
});
