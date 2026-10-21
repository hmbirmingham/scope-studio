import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkCell } from '../../src/plugins/research/extract.js';
import { scorer, tsQuery } from '../../src/plugins/research/store.js';
import { chunkPages, findCitations, findDois, findQuotes, htmlToText, normalizeDoi, normalizeText, terms } from '../../src/plugins/research/text.js';
import { quoteIn } from '../../src/plugins/research/verifiers.js';

describe('research text: normalising', () => {
  test('folds whitespace and typographic variants, and nothing else', () => {
    assert.equal(normalizeText('  a\n\tb  c '), 'a b c');
    assert.equal(normalizeText('“smart” ‘quotes’ — and…'), '"smart" \'quotes\' - and...');
    assert.equal(normalizeText('ﬁne-grained'), 'fine-grained', 'ligatures from PDFs unfold');
    assert.equal(normalizeText('soft­hyphen'), 'softhyphen');
    assert.notEqual(normalizeText('Case'), normalizeText('case'), 'case still matters');
  });

  test('turns Zotero note HTML into text', () => {
    assert.equal(htmlToText('<div><p>Key: <b>18.2</b> &amp; more</p><p>Next&#39;s &#x41;</p></div>'), "Key: 18.2 & more Next's A");
    assert.equal(htmlToText('a<br>b'), 'a b');
    assert.equal(htmlToText(null), '');
  });

  test('search terms drop stopwords and duplicates and keep numbers', () => {
    assert.deepEqual(terms('Which method has the lowest perplexity on the LongText benchmark? LongText!'), ['lowest', 'perplexity', 'longtext', 'benchmark']);
    assert.deepEqual(terms('a perplexity of 18.2'), ['perplexity', '18.2']);
    assert.deepEqual(terms('the of and'), []);
  });

  test('DOIs compare without resolver prefix or case', () => {
    assert.equal(normalizeDoi('https://doi.org/10.5555/FIXTURE.0002'), '10.5555/fixture.0002');
    assert.equal(normalizeDoi('doi: 10.5555/x.1.'), '10.5555/x.1');
    assert.equal(normalizeDoi('not a doi'), null);
    assert.equal(normalizeDoi(42), null);
    assert.deepEqual(findDois('see doi:10.5555/fixture.0001, and https://doi.org/10.5555/FIXTURE.0001.'), ['10.5555/fixture.0001']);
  });
});

describe('research text: citations and quotations', () => {
  test('reads Pandoc citations with pages and groups', () => {
    assert.deepEqual(findCitations('As shown [@doe2021sparse, p. 2]; see also [@lee2019recurrent; @kim2022survey].'), [
      { citekey: 'doe2021sparse', page: 2 },
      { citekey: 'lee2019recurrent', page: null },
      { citekey: 'kim2022survey', page: null },
    ]);
    assert.deepEqual(findCitations('email me@example.com is not a citation'), []);
    assert.deepEqual(findCitations('[@key.]'), [{ citekey: 'key', page: null }]);
  });

  test('reads quotations with their citation, and flags uncited ones', () => {
    const text = 'They report "a perplexity of 18.2 on the LongText benchmark" [@doe2021sparse, p. 2] and “constant memory for any stream”. A "short" word is not a quote.';
    assert.deepEqual(findQuotes(text), [
      { text: 'a perplexity of 18.2 on the LongText benchmark', citekey: 'doe2021sparse', page: 2 },
      { text: 'constant memory for any stream', citekey: null, page: null },
    ]);
  });

  test('a quotation matches verbatim after normalising, including elisions in order', () => {
    const source = 'Our sparse model reaches a perplexity of 18.2 on the\nLongText benchmark.';
    assert.ok(quoteIn('reaches a perplexity of 18.2 on the LongText benchmark', source));
    assert.ok(quoteIn('Our sparse model ... LongText benchmark', source));
    assert.ok(!quoteIn('LongText benchmark ... Our sparse model', source), 'elided parts must be in order');
    assert.ok(!quoteIn('reaches a perplexity of 18.3', source));
    assert.ok(!quoteIn('our sparse model', source), 'case matters');
    assert.ok(!quoteIn('', source));
  });
});

describe('research text: chunking pages', () => {
  test('one excerpt per short page, numbered from 1', () => {
    assert.deepEqual(chunkPages(['First page.', '', 'Third page.']), [
      { page: 1, chunk: 0, text: 'First page.' },
      { page: 3, chunk: 0, text: 'Third page.' },
    ]);
  });

  test('a long page splits at sentence ends without losing or repeating text', () => {
    const page = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something useful.`).join(' ');
    const chunks = chunkPages([page], { maxChars: 300 });
    assert.ok(chunks.length > 4);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 300);
      assert.equal(chunk.page, 1);
      assert.match(chunk.text, /\.$/, 'cut at a sentence end');
    }
    assert.equal(chunks.map((c) => c.text).join(' '), normalizeText(page));
  });

  test('a page with no sentence ends still splits at spaces', () => {
    const page = 'word '.repeat(200);
    const chunks = chunkPages([page], { maxChars: 100 });
    assert.equal(chunks.map((c) => c.text).join(' '), normalizeText(page));
    assert.ok(chunks.every((c) => c.text.length <= 100));
  });
});

describe('research ranking helpers', () => {
  test('the full-text query is prefix terms split like the index', () => {
    assert.equal(tsQuery(['perplexity', '18.2', 'long-text']), 'perplexity:* | 18:* | long:* | text:*');
    assert.equal(tsQuery(['x']), '');
  });

  test('rarer words weigh more', () => {
    const score = scorer(['perplexity', 'benchmark'], ['perplexity benchmark', 'benchmark', 'benchmark only', 'nothing']);
    assert.ok(score('perplexity').score > score('benchmark').score);
    assert.deepEqual(score('the benchmark').matched, ['benchmark']);
    assert.equal(score('unrelated').score, 0);
  });
});

describe('extraction cells', () => {
  const offered = [{ label: 'E1', excerpt: { id: 'x1', page: 2, text: 'Our sparse model reaches a perplexity of 18.2 on the LongText benchmark.' } }];

  test('a value is kept only with a verbatim quote from the excerpt it names', () => {
    assert.deepEqual(checkCell({ value: '18.2', excerpt: 'e1', quote: 'a perplexity of 18.2' }, offered), { value: '18.2', status: 'supported', excerptId: 'x1', page: 2, quote: 'a perplexity of 18.2' });
    assert.equal(checkCell({ value: 18.2, excerpt: 'E1', quote: '"a perplexity of 18.2"' }, offered).status, 'supported', 'numbers and quoted quotes are accepted');
  });

  test('anything unsupported is left empty and says why', () => {
    assert.equal(checkCell(null, offered).status, 'not_found');
    assert.equal(checkCell({ value: '' }, offered).status, 'not_found');
    assert.equal(checkCell('18.2', offered).status, 'unsupported');
    assert.match(checkCell({ value: '18.2', excerpt: 'E9', quote: 'a perplexity of 18.2' }, offered).reason, /no offered excerpt/);
    assert.match(checkCell({ value: '18.2', excerpt: 'E1', quote: 'a perplexity of 17.0' }, offered).reason, /not in E1/);
    assert.match(checkCell({ value: '18.2', excerpt: 'E1' }, offered).reason, /no supporting quote/);
    assert.equal(checkCell({ value: '18.2', excerpt: 'E1', quote: 'a perplexity of 17.0' }, offered).value, null);
  });
});
