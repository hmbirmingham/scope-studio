import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toLexicalTerms } from '../../src/retrieval/retrieve.js';

describe('toLexicalTerms', () => {
  test('keeps two-character reference designators the index stores as one lexeme', () => {
    assert.deepEqual(toLexicalTerms('what value is C2'), ['value', 'c2']);
    assert.deepEqual(toLexicalTerms('what is U1 connected to'), ['u1', 'connected']);
    assert.deepEqual(toLexicalTerms('J1 and 5V'), ['j1', '5v']);
  });

  test('still drops other short tokens and stopwords', () => {
    assert.deepEqual(toLexicalTerms('is it ok to go 42 by the way'), []);
    assert.deepEqual(toLexicalTerms('what does quantify_colonies return'), ['quantify', 'colonies', 'return']);
  });
});
