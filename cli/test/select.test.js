import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEADING_BOOST, fitRendered, fuse, lexicalRanking, lexicalTerms, pack, rareTerms, render } from '../src/core/select.js';
import { chunkSource } from '../src/core/chunk.js';

const source = { label: 'p', attr: 'uri', ref: 'https://example.com/p', text: '' };
const chunk = (index, text, heading = null, tokens = 10) => ({ index, text, heading, tokens, source });

test('stopwords and short tokens are dropped from the query terms', () => {
  assert.deepEqual(lexicalTerms('What are the standard ways people evaluate RAG retrieval?'), [
    'evaluate',
    'rag',
    'retrieval',
  ]);
});

test('one common term is not a hit, but one rare term is', () => {
  const chunks = [
    chunk(0, 'retrieval appears here'),
    chunk(1, 'retrieval appears here too'),
    chunk(2, 'retrieval and also pgvector'),
    ...Array.from({ length: 17 }, (_, i) => chunk(3 + i, 'retrieval filler')),
  ];
  const terms = ['retrieval', 'pgvector'];
  assert.deepEqual([...rareTerms(chunks, terms)], ['pgvector']);
  const ranked = lexicalRanking(chunks, terms);
  // Only the chunk carrying the rare term is admitted on a single match; the
  // rest share one common word, which is noise RRF would otherwise reward.
  assert.deepEqual(
    ranked.map((r) => r.chunk.index),
    [2]
  );
});

test('a heading that names a query term boosts its chunk above an equal rival', () => {
  const chunks = [chunk(0, 'mentions dcg in passing'), chunk(1, 'mentions dcg in passing', 'Discounted cumulative gain')];
  const ranked = fuse({ chunks, terms: ['dcg', 'cumulative'], lexical: lexicalRanking(chunks, ['dcg', 'cumulative']), dense: null });
  assert.equal(ranked[0].chunk.index, 1);
  assert.ok(ranked[0].score > ranked[1].score * (1 + HEADING_BOOST) * 0.9);
});

test('with no term overlap and no embeddings, document order is used rather than nothing', () => {
  const chunks = [chunk(0, 'alpha'), chunk(1, 'beta')];
  const ranked = fuse({ chunks, terms: ['zzz'], lexical: [], dense: null });
  assert.deepEqual(
    ranked.map((r) => r.chunk.index),
    [0, 1]
  );
});

test('the best chunk is always taken, even when it alone exceeds the budget', () => {
  const ranked = [{ chunk: chunk(0, 'big', null, 5000) }, { chunk: chunk(1, 'small', null, 10) }];
  const packed = pack(ranked, 100);
  // A run that sends nothing is strictly worse than one that sends its best
  // guess and reports the overflow.
  assert.equal(packed.taken.length, 1);
  assert.equal(packed.overflowed, true);
});

test('packing skips an oversized chunk rather than stopping at it', () => {
  const ranked = [{ chunk: chunk(0, 'a', null, 10) }, { chunk: chunk(1, 'huge', null, 900) }, { chunk: chunk(2, 'c', null, 10) }];
  const packed = pack(ranked, 100);
  assert.deepEqual(
    packed.taken.map((t) => t.chunk.index),
    [0, 2]
  );
});

test('selected chunks render in document order with gaps marked', () => {
  const taken = [{ chunk: chunk(4, 'fourth') }, { chunk: chunk(1, 'first') }];
  const out = render(taken);
  assert.match(out, /<source uri="https:\/\/example\.com\/p" excerpt="true">/);
  // Leading elision, because chunk 0 was left out; and an interior one.
  assert.equal(out.indexOf('first') < out.indexOf('fourth'), true);
  assert.equal((out.match(/\[\.\.\.\]/g) ?? []).length, 2);
});

test('a complete selection from the top is not marked as elided at the front', () => {
  const taken = [{ chunk: chunk(0, 'a') }, { chunk: chunk(1, 'b') }];
  assert.doesNotMatch(render(taken), /\[\.\.\.\]/);
});

test('chunks keep their source, so an excerpt can still say where it came from', () => {
  const doc = { label: 'page', attr: 'uri', ref: 'https://x/y', text: '## H\nbody here' };
  const [first] = chunkSource(doc);
  assert.equal(first.source.ref, 'https://x/y');
});

test('a selection that renders over budget is shrunk, lowest score first', () => {
  // Packing counts chunk tokens; the prompt carries the rendered form with its
  // wrapper and markers. The first live two-page run packed inside budget and
  // rendered 43 tokens over the window.
  const taken = [
    { chunk: chunk(0, 'a '.repeat(200), null, 100), score: 0.9 },
    { chunk: chunk(1, 'b '.repeat(200), null, 100), score: 0.5 },
    { chunk: chunk(2, 'c '.repeat(200), null, 100), score: 0.1 },
  ];
  const { kept, tokens } = fitRendered(taken, 160);
  assert.ok(tokens <= 160, `rendered ${tokens} tokens against a 160 budget`);
  assert.deepEqual(
    kept.map((k) => k.chunk.index),
    [0]
  );
});

test('shrinking never empties the selection', () => {
  const taken = [{ chunk: chunk(0, 'x '.repeat(400), null, 200), score: 0.9 }];
  const { kept } = fitRendered(taken, 10);
  assert.equal(kept.length, 1);
});
