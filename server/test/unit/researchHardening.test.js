import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { baselineCapabilities } from '../../src/benchmark/tasks/baselineArm.js';
import { registerBuiltInPlugins } from '../../src/plugins/registry.js';
import { extractionTable } from '../../src/plugins/research/extract.js';
import { readBetterBibtexJson, readZoteroSqlite } from '../../src/plugins/research/library.js';
import { sweepReport } from '../../src/plugins/research/sweep.js';
import { MAX_NOTE_CHARS, MAX_SCAN_CHARS, findCitations, findQuotes, htmlToText } from '../../src/plugins/research/text.js';
import { verifyCitations, verifyQuotes } from '../../src/plugins/research/verifiers.js';

// Malformed or hostile input to the research readers: each must finish
// quickly and fail, if at all, as a ResearchError the job can report.

function timed(fn) {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

describe('research text: linear time on malformed input', () => {
  test('note HTML full of unclosed tags converts in well under a second', () => {
    const { value, ms } = timed(() => htmlToText('<'.repeat(200_000)));
    assert.ok(ms < 250, `took ${Math.round(ms)} ms`);
    assert.equal(value, '<'.repeat(200_000));
    const breaks = timed(() => htmlToText('<br'.repeat(60_000)));
    assert.ok(breaks.ms < 250, `took ${Math.round(breaks.ms)} ms`);
  });

  test('tags still come out, and a note beyond the cap is cut before converting', () => {
    assert.equal(htmlToText('a <b>bold</b> < c <i x="1">d</i>'), 'a bold < c d');
    assert.equal(htmlToText('x'.repeat(MAX_NOTE_CHARS + 50)).length, MAX_NOTE_CHARS);
  });

  test('an unclosed citation group full of @ is read in well under a second', () => {
    const text = `[${'@a'.repeat(50_000)}`;
    const cites = timed(() => findCitations(text));
    assert.ok(cites.ms < 250, `took ${Math.round(cites.ms)} ms`);
    assert.deepEqual(cites.value, []);
    const quotes = timed(() => findQuotes(`"one two three" ${text}`));
    assert.ok(quotes.ms < 250, `took ${Math.round(quotes.ms)} ms`);
    assert.deepEqual(quotes.value, [{ text: 'one two three', citekey: null, page: null }]);
  });

  test('citation groups with text before the first @ still read', () => {
    assert.deepEqual(findCitations('[see @doe2021, p. 4; and @lee2019]'), [
      { citekey: 'doe2021', page: 4 },
      { citekey: 'lee2019', page: null },
    ]);
  });

  test('the verifiers refuse text longer than they scan instead of passing it', async () => {
    const result = { output: { paragraph: `${'x '.repeat(MAX_SCAN_CHARS / 2)}[@missing]` } };
    const ctx = { agent: null, ownerId: null };
    const citations = await verifyCitations(result, ctx);
    assert.equal(citations.ok, false);
    assert.match(citations.detail, /more than/);
    const quotes = await verifyQuotes(result, ctx, null);
    assert.equal(quotes.ok, false);
  });
});

describe('research reports: no quotations that nobody wrote', () => {
  test('quote marks inside excerpts and titles do not pair across lines in a sweep', () => {
    const papers = [
      { title: 'On "sparse" attention', authors: ['Doe'], year: 2021, citekey: 'doe2021', doi: null, score: 1, excerpts: [{ page: 1, text: 'They call it "the fast path for' }] },
      { title: 'Recurrent', authors: ['Lee'], year: 2019, citekey: 'lee2019', doi: null, score: 0.5, excerpts: [{ page: 2, text: 'long inputs" in the end.' }] },
    ];
    const report = sweepReport('what is "fast"?', papers);
    assert.deepEqual(findQuotes(report), []);
    assert.match(report, /They call it 'the fast path for/);
  });

  test('model values with quotes in a table are not read as quotations; evidence lines are', () => {
    const columns = [{ name: 'Result' }];
    const rows = [{ citekey: 'doe2021', title: 'Doe', cells: { Result: { status: 'supported', value: 'called "best of the three" by the authors', quote: 'perplexity of 18.2 on LongText', page: 3 } } }];
    assert.deepEqual(findQuotes(extractionTable(columns, rows)), [{ text: 'perplexity of 18.2 on LongText', citekey: 'doe2021', page: 3 }]);
  });
});

describe('research libraries: malformed input is library_unreadable or tolerated', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scope-research-bad-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('a Better BibTeX export with null notes and non-string fields still reads', async () => {
    const path = join(dir, 'odd.json');
    const items = [
      { itemKey: 'AAAA1111', itemType: 'journalArticle', title: 'Odd fields', citationKey: 42, date: 2020, creators: [null, { lastName: 7 }], notes: [null, 5, { note: { html: 1 } }, { key: 9, note: '<p>kept</p>' }], attachments: [null, { path: 3 }] },
      { itemKey: 7, itemType: 'note', note: null },
    ];
    await writeFile(path, JSON.stringify({ items }));
    const library = await readBetterBibtexJson(path);
    assert.equal(library.items.length, 1);
    const [item] = library.items;
    assert.equal(typeof item.citekey, 'string');
    assert.deepEqual(item.notes, [{ key: 'N3', text: 'kept' }]);
    assert.deepEqual(item.attachments, []);
  });

  test('a SQLite file with an items table but no Zotero schema is library_unreadable', async () => {
    const path = join(dir, 'zotero.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE items (itemID INTEGER PRIMARY KEY, key TEXT)');
    db.close();
    await assert.rejects(readZoteroSqlite(path), (err) => err.code === 'library_unreadable' && /not a complete Zotero database/.test(err.message));
  });
});

describe('task benchmark baseline', () => {
  test('the baseline research tools include none that reach the web', () => {
    registerBuiltInPlugins();
    const names = baselineCapabilities('research').map((capability) => capability.name);
    assert.ok(names.includes('research.sweep'));
    assert.ok(!names.includes('research.web_search'));
  });
});
