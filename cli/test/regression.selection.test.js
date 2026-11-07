import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkSource } from '../src/core/chunk.js';
import { parseTask } from '../src/core/task.js';
import { loadRubric } from '../src/eval/rubric.js';
import { select } from '../src/core/select.js';
import { normalizeQuote } from '../src/eval/analysis.js';
import { estimateTokens } from '../src/runners/local.js';

// The regression fixture: the two-page case that used to be refused outright.
// ~54k characters of fetched text against an 8,192-token window, which is the
// condition the whole selection layer exists for.
//
// The pages are snapshotted rather than fetched. A test that reaches Wikipedia
// is not a regression test — it fails when the network is down and it changes
// meaning when somebody edits an article.
//
// Selection runs lexical-only here, with the embedding host pointed at a closed
// port so `denseScores` returns null. That is deliberate: the dense ranking
// depends on a model that may not be pulled, so what has to be guarded is the
// LEXICAL FLOOR — the ranking that runs when embeddings are unavailable. A
// regression that only shows up without embeddings is exactly the one that
// would reach a laptop with no `nomic-embed-text`.
const config = {
  ollama: { host: 'http://127.0.0.1:9', model: 'qwen3:8b', contextTokens: 8192 },
};

// The question comes from the pinned copy of the task file, not from a constant
// here. The live task lives in the vault, where it can be edited; a hardcoded
// copy of its prompt would go stale silently and this fixture would quietly
// start testing a question nobody asks.
async function task() {
  const dir = join(import.meta.dirname, 'fixtures');
  const text = await readFile(join(dir, 'retrieval-metrics-brief.md'), 'utf8');
  return parseTask(text, 'fixtures/retrieval-metrics-brief.md', await loadRubric('research-brief'));
}

// What a correct brief has to be able to cite. These are the sentences the live
// runs actually reached for, verbatim from the pages. If a change to scoring
// drops the chunks holding them, every grounding failure becomes attributable
// to selection and the gates stop meaning anything — so this is the assertion
// that keeps the selection layer safe to have at all.
const MUST_REMAIN_CITABLE = [
  'Discounted cumulative gain (DCG) is a measure of ranking quality',
  'Precision (also called positive predictive value) is the fraction of relevant instances among the retrieved instances',
];

async function sources() {
  const dir = join(import.meta.dirname, 'fixtures');
  return [
    {
      label: 'dcg',
      attr: 'uri',
      ref: 'https://en.wikipedia.org/wiki/Discounted_cumulative_gain',
      text: await readFile(join(dir, 'dcg.txt'), 'utf8'),
      privacy: 'public',
    },
    {
      label: 'precision-recall',
      attr: 'uri',
      ref: 'https://en.wikipedia.org/wiki/Precision_and_recall',
      text: await readFile(join(dir, 'precision-recall.txt'), 'utf8'),
      privacy: 'public',
    },
  ];
}

// The budget the real run computes: the window less the answer reserve, the
// correction reserve, the system prompt and the question.
const BUDGET = 5800;

test('regression: the two pages do not fit the window whole', async () => {
  // If this ever stops being true the rest of the fixture is testing nothing.
  const docs = await sources();
  const whole = docs.map((d) => d.text).join('\n\n');
  assert.ok(
    estimateTokens(whole) > config.ollama.contextTokens,
    `fixture is only ~${estimateTokens(whole)} tokens; it must exceed ${config.ollama.contextTokens}`
  );
});

test('regression: selection fits the budget and keeps the citable sentences', async () => {
  const docs = await sources();
  const selection = await select(config, (await task()).prompt, docs, BUDGET);

  assert.equal(selection.dense, false, 'this fixture guards the lexical floor');
  assert.ok(selection.tokens <= BUDGET, `selected ~${selection.tokens} tokens against a ${BUDGET} budget`);
  assert.ok(selection.selected > 1, 'a brief over two pages needs more than one chunk');
  assert.ok(selection.elided > 0, 'if nothing is elided this case is no longer the overflow case');

  const haystack = normalizeQuote(selection.text);
  for (const sentence of MUST_REMAIN_CITABLE) {
    assert.ok(
      haystack.includes(normalizeQuote(sentence)),
      `selection dropped a sentence the answer has to cite: "${sentence.slice(0, 60)}…"`
    );
  }
});

test('regression: both pages survive selection, not just the better-matching one', async () => {
  // A question comparing two things cannot be answered from one of them, and
  // the ranking is per-chunk with no per-source quota — so this is a real risk,
  // not a hypothetical.
  const docs = await sources();
  const selection = await select(config, (await task()).prompt, docs, BUDGET);
  for (const ref of docs.map((d) => d.ref)) {
    assert.match(selection.text, new RegExp(`uri="${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
});

test('regression: chunking adds nothing quotable that the page did not contain', async () => {
  // Quotes ground against chunk text, so anything this layer injects becomes
  // citable material the source never had — which is how a grounding gate ends
  // up validating the harness's own prose.
  //
  // The invariant is equality under the same whitespace folding grounding
  // applies, not strict byte equality: the chunker collapses runs of blank
  // lines, and `normalizeQuote` folds whitespace on both sides anyway. Testing
  // strict bytes would pass here by luck of the fixture and fail later for a
  // reason that cannot affect a quote.
  const docs = await sources();
  for (const doc of docs) {
    const haystack = normalizeQuote(doc.text);
    for (const chunk of chunkSource(doc)) {
      assert.ok(
        haystack.includes(normalizeQuote(chunk.text)),
        `chunk ${chunk.index} of ${doc.label} is not in the page: "${chunk.text.slice(0, 60)}…"`
      );
    }
  }
});
