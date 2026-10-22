import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hardWording, questionDifficulty } from '../../src/routing/difficulty.js';

describe('questionDifficulty', () => {
  test('comparisons, causes, code changes and reviews are hard by wording', () => {
    for (const q of [
      'compare imaging system to other competitive systems in that field',
      'pgvector vs pinecone for this',
      'why does the first migration enable pgvector',
      'refactor the chunker to stream files',
      'review the ingest pipeline for failure modes',
      'what are the trade-offs of HNSW here',
    ]) assert.equal(hardWording(q), 'wording', q);
  });

  test('lookups stay local', () => {
    for (const q of ['what does quantify_colonies return', 'where is the upload handler', 'what is imaging system',
      'how is the USART peripheral configured on the STM32 board', 'describe a tree']) {
      assert.equal(questionDifficulty(q), null, q);
    }
  });

  test('a request that opens on a change verb is hard', () => {
    for (const q of [
      'Fix that bug in dispose_engine.',
      'fix solve_2cmt so a short bolus cannot be stepped over',
      'Add a unit test that checks apply_profile drops touching_colony',
      'make the rate limit per coach instead of global',
      'please rename quantify to count_colonies',
    ]) assert.equal(hardWording(q), 'wording', q);
    // The same words inside a lookup are not a request for work.
    for (const q of ['what is the fix-up script in tools for', 'where do we add the auth header', 'which file makes the thumbnails']) {
      assert.equal(hardWording(q), null, q);
    }
  });

  test('long and multi-part questions are hard', () => {
    assert.equal(hardWording(Array.from({ length: 36 }, (_, i) => `word${i}`).join(' ')), 'length');
    assert.equal(hardWording('where is it set? and where is it read?'), 'multi_part');
  });

});
