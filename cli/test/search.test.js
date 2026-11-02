import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrivacyRefusal, parseGrounding, privacyViolations, search, searchConfigured } from '../src/runners/search.js';

const configured = { search: { apiKey: 'test-key', model: 'gemini-2.5-flash' } };

test('searchConfigured reports whether a key exists', () => {
  assert.equal(searchConfigured(configured), true);
  assert.equal(searchConfigured({ search: { apiKey: null } }), false);
  assert.equal(searchConfigured({}), false);
});

test('a plain question about the world is sendable', () => {
  assert.deepEqual(privacyViolations('How do people evaluate retrieval quality in RAG systems?'), []);
});

test('vault material is refused, since the free tier trains on what it receives', () => {
  assert.deepEqual(privacyViolations('<source path="meetings/a.md">\nlecture text\n</source>'), [
    'source material block',
  ]);
  assert.deepEqual(privacyViolations('See [[CSE 2600]] for context'), ['vault wikilink']);
  assert.deepEqual(privacyViolations('read /Users/mikeyb/Documents/notes.md'), ['local filesystem path']);
  assert.deepEqual(
    privacyViolations('---\ngranola_id: abc\n---\n'),
    ['vault note frontmatter']
  );
});

test('a credential-shaped string is refused', () => {
  assert.deepEqual(privacyViolations('is sk-ant-abcdefghijklmnopqrstuv valid?'), ['credential-shaped string']);
  assert.deepEqual(privacyViolations('AIzaSyAbcdefghijklmnopqrstuvwxyz12 broken?'), ['credential-shaped string']);
});

test('several violations are all reported, not just the first', () => {
  const found = privacyViolations('[[HCA]] at /Users/mikeyb/x');
  assert.deepEqual(found.sort(), ['local filesystem path', 'vault wikilink']);
});

test('search refuses before it reaches the network', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error('should never be reached');
  };
  try {
    await assert.rejects(
      () => search(configured, { query: 'summarise [[CSE 2600]]' }),
      (err) => err instanceof PrivacyRefusal && /never material from this machine/.test(err.message)
    );
    assert.equal(called, false, 'nothing was sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search without a key fails before the privacy check even matters', async () => {
  await assert.rejects(() => search({}, { query: 'anything' }), /no search key/);
});

test('grounding citations and supports are parsed out of a response', () => {
  const body = {
    candidates: [
      {
        content: { parts: [{ text: 'nDCG and recall@k are standard.' }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://example.com/a', title: 'Evaluating retrieval' } },
            { web: { title: 'no uri so dropped' } },
          ],
          groundingSupports: [
            { segment: { text: 'nDCG and recall@k are standard.' }, groundingChunkIndices: [0] },
          ],
        },
      },
    ],
  };
  const { text, sources, supports } = parseGrounding(body);
  assert.equal(text, 'nDCG and recall@k are standard.');
  assert.deepEqual(sources, [{ uri: 'https://example.com/a', title: 'Evaluating retrieval' }]);
  assert.equal(supports.length, 1);
  assert.deepEqual(supports[0].sourceIndexes, [0]);
});

test('an ungrounded or empty response parses to nothing rather than throwing', () => {
  assert.deepEqual(parseGrounding({}), { text: '', sources: [], supports: [] });
  assert.deepEqual(parseGrounding({ candidates: [{ content: { parts: [] } }] }).sources, []);
});

test('a successful search renders its citations as source material for the gates', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: { parts: [{ text: 'answer' }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'A title' } }],
          },
        },
      ],
    }),
  });
  try {
    const result = await search(configured, { query: 'what is recall@k?' });
    assert.equal(result.output, 'answer');
    assert.match(result.sourceText, /<source index="1" uri="https:\/\/example\.com\/a">/);
    assert.equal(result.model, 'gemini/gemini-2.5-flash');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an HTTP error surfaces its status and body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  try {
    await assert.rejects(() => search(configured, { query: 'ok' }), /HTTP 429: rate limited/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a key shape the prefix list does not know is still refused', () => {
  // A real key with an unlisted prefix slipped past the prefix-only version of
  // this check on the day it was written. These are fabricated stand-ins.
  const synthetic = ['AQ.', 'Xy7', 'QwErTyUiOpAsDfGhJkL1234567890'].join('');
  assert.deepEqual(privacyViolations(`does ${synthetic} work?`), ['credential-shaped string']);
  assert.deepEqual(privacyViolations('is xoxb-1234567890-abcdefghij valid?'), ['credential-shaped string']);
});

test('ordinary long words and phrasings are not mistaken for credentials', () => {
  assert.deepEqual(privacyViolations('explain antidisestablishmentarianism in detail please'), []);
  assert.deepEqual(privacyViolations('what does cross-validation mean in machine learning?'), []);
  assert.deepEqual(privacyViolations('compare retrieval augmented generation and finetuning'), []);
});
