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

  test('drafting prose or code is hard', () => {
    for (const q of [
      'Draft a related-work paragraph in LaTeX on definitions of reproducibility',
      "Write a methods paragraph following the guide's checklist",
      'write a function that converts pixel areas to mm²',
      'compose a reply to the reviewer',
    ]) assert.equal(hardWording(q), 'wording', q);
    for (const q of ['where do we write the CSV header', 'who wrote the reproducibility survey', 'what does the draft say about FAIR']) {
      assert.equal(hardWording(q), null, q);
    }
  });

  test('judging whether something is safe, enough or wise is hard', () => {
    for (const q of [
      'Is RedisBackend.cleanup safe under concurrent requests?',
      'is 22u enough output capacitance for the AP2112 at full load',
      'does the LED resistor value give a safe current at 3.3 V',
      'will the bracket hold a 20 kg load at the end of the arm',
      'should we move the poll state into Redis',
      'what would break if we raised the blur kernel to 301',
    ]) assert.equal(hardWording(q), 'wording', q);
    for (const q of ['is the Proteus profile validated', 'does the bibliography have duplicate entries', 'what is the safe operating area table in the datasheet']) {
      assert.equal(hardWording(q), null, q);
    }
  });

  test('proposals, derivations, explanations and check runs are hard', () => {
    for (const q of [
      'Suggest which passives could be consolidated to cut unique BOM lines',
      'propose a way to make housing.stl watertight',
      'derive the period of a physical pendulum with a rod of mass m',
      'explain the difference between the watershed and threshold results',
      'Run an ERC-style check: which power inputs are driven by nothing?',
    ]) assert.equal(hardWording(q), 'wording', q);
    for (const q of ['check the BOM for the part number of the MOSFET', 'what does the guide suggest for licences',
      'which check runs on every push']) {
      assert.equal(hardWording(q), null, q);
    }
  });

  test('long and multi-part questions are hard', () => {
    assert.equal(hardWording(Array.from({ length: 36 }, (_, i) => `word${i}`).join(' ')), 'length');
    assert.equal(hardWording('where is it set? and where is it read?'), 'multi_part');
  });

});
