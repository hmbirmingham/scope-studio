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

  test('long and multi-part questions are hard', () => {
    assert.equal(hardWording(Array.from({ length: 36 }, (_, i) => `word${i}`).join(' ')), 'length');
    assert.equal(hardWording('where is it set? and where is it read?'), 'multi_part');
  });

});
