import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { readBetterBibtexJson, readLibrary, readZoteroSqlite } from '../../src/plugins/research/library.js';
import { createPdfText } from '../../src/plugins/research/pdf.js';
import { PAPERS, betterBibtexPath, buildLibrary, makePdf, pdfPath, recordedTextPath } from '../fixtures/research/build.js';

const dirs = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-unit-'));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const pdftotext = await createPdfText().status();
const needsPdftotext = pdftotext.available ? false : `pdftotext is not installed (${pdftotext.reason})`;
if (needsPdftotext) console.log(`# using recorded pdftotext output: ${needsPdftotext}`);

const byKey = (library) => Object.fromEntries(library.items.map((item) => [item.citekey, item]));

describe('reading a zotero.sqlite library', () => {
  test('papers with their fields, authors, notes, PDFs and relations; the trash and notes-as-items left out', async () => {
    const lib = buildLibrary(temp());
    const library = await readZoteroSqlite(lib.sqlite);
    assert.equal(library.format, 'zotero-sqlite');
    assert.deepEqual(library.items.map((item) => item.citekey), ['doe2021sparse', 'lee2019recurrent', 'kim2022survey']);
    const { doe2021sparse: doe, lee2019recurrent: lee, kim2022survey: kim } = byKey(library);
    assert.equal(doe.title, 'Sparse Attention for Long Documents');
    assert.deepEqual(doe.creators, [{ name: 'Jane Doe', type: 'author' }, { name: 'Rex Roe', type: 'author' }]);
    assert.equal(doe.year, 2021);
    assert.equal(doe.doi, '10.5555/fixture.0001');
    assert.deepEqual(doe.notes, [{ key: 'NOTE1111', text: 'Key result: 18.2 perplexity on LongText & linear cost.' }]);
    assert.equal(doe.attachments[0].path, join(lib.storage, 'PDFA1111', 'doe2021sparse.pdf'));
    // The citekey from Zotero's "extra" field, and the DOI from a resolver URL.
    assert.equal(lee.citekey, 'lee2019recurrent');
    assert.equal(lee.doi, '10.5555/fixture.0002');
    assert.equal(lee.publication, 'Journal of Fixture Studies');
    // No key recorded: Better BibTeX's default shape; a single-field creator.
    assert.equal(kim.citekey, 'kim2022survey');
    assert.deepEqual(kim.creators[1], { name: 'Fixture Editors', type: 'editor' });
    assert.deepEqual(kim.relations, ['AAAA1111', 'BBBB2222'], 'dc:relation only, and only to items in the library');
    assert.ok(!library.items.some((item) => item.title === 'An Item In The Trash'));
  });

  test('reads a copy, so a library Zotero holds locked can still be read and is never changed', async () => {
    const lib = buildLibrary(temp());
    const before = readFileSync(lib.sqlite);
    const holder = new DatabaseSync(lib.sqlite);
    holder.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
    try {
      const library = await readLibrary(lib.sqlite);
      assert.equal(library.items.length, 3);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    assert.deepEqual(readFileSync(lib.sqlite), before);
  });

  test('a stored attachment name that climbs out of its folder is not followed', async () => {
    const lib = buildLibrary(temp());
    const db = new DatabaseSync(lib.sqlite);
    db.exec("UPDATE itemAttachments SET path = 'storage:../../../etc/x.pdf' WHERE itemID = 4");
    db.close();
    const library = await readLibrary(lib.sqlite);
    assert.equal(library.items[0].attachments[0].path, null);
  });

  test('a storage directory elsewhere can be named', async () => {
    const lib = buildLibrary(temp());
    const library = await readLibrary(lib.sqlite, { storageDir: '/elsewhere/storage' });
    assert.equal(library.items[0].attachments[0].path, '/elsewhere/storage/PDFA1111/doe2021sparse.pdf');
  });

  test('clashing citekeys get a, b suffixes', async () => {
    const lib = buildLibrary(temp());
    const db = new DatabaseSync(lib.sqlite);
    db.exec("INSERT INTO itemDataValues VALUES (99, 'lee2019recurrent'); INSERT INTO itemData VALUES (3, 6, 99);");
    db.close();
    const keys = (await readLibrary(lib.sqlite)).items.map((item) => item.citekey);
    assert.deepEqual(keys, ['doe2021sparse', 'lee2019recurrent', 'lee2019recurrenta']);
  });

  test('refuses what is not a library, and relative paths', async () => {
    const dir = temp();
    await assert.rejects(readLibrary('relative/zotero.sqlite'), { code: 'invalid_path' });
    await assert.rejects(readLibrary(join(dir, 'missing.sqlite')), { code: 'library_missing' });
    await assert.rejects(readLibrary(dir), { code: 'library_missing' });
    const other = join(dir, 'other.sqlite');
    const db = new DatabaseSync(other);
    db.exec('CREATE TABLE t (x)');
    db.close();
    await assert.rejects(readLibrary(other), { code: 'library_unreadable' });
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    await assert.rejects(readLibrary(join(dir, 'bad.json')), { code: 'library_unreadable' });
    writeFileSync(join(dir, 'wrong.json'), '{"records": []}');
    await assert.rejects(readLibrary(join(dir, 'wrong.json')), /no items/);
  });
});

describe('reading a Better BibTeX JSON export', () => {
  test('gives the same papers as the database, plus standalone notes', async () => {
    const fromJson = await readBetterBibtexJson(betterBibtexPath);
    const fromDb = await readZoteroSqlite(buildLibrary(temp()).sqlite);
    assert.equal(fromJson.format, 'better-bibtex');
    const strip = (library) => library.items.map(({ attachments, ...item }) => ({ ...item, attachments: attachments.map((a) => a.key) }));
    assert.deepEqual(strip(fromJson), strip(fromDb));
    assert.deepEqual(fromJson.notes, [{ key: 'NOTE9999', text: 'Standalone note: compare memory and sparsity on LongText.' }]);
    assert.equal(fromJson.items[0].attachments[0].path, pdfPath('doe2021sparse'), 'relative attachment paths resolve against the export');
  });
});

describe('PDF text', () => {
  test('the fixture PDFs are what build.js writes', () => {
    for (const [citekey, pages] of Object.entries(PAPERS)) assert.deepEqual(readFileSync(pdfPath(citekey)), makePdf(pages), citekey);
  });

  test('pdftotext reads the fixture PDFs page by page, as recorded', { skip: needsPdftotext }, async () => {
    const pdf = createPdfText();
    for (const citekey of Object.keys(PAPERS)) {
      const pages = await pdf.pages(pdfPath(citekey));
      assert.equal(pages.length, PAPERS[citekey].length);
      assert.deepEqual(pages, readFileSync(recordedTextPath(citekey), 'utf8').split('\f').slice(0, -1));
      assert.match(pages[0], new RegExp(PAPERS[citekey][0][0]));
    }
    const [second] = await pdf.pages(pdfPath('doe2021sparse'), { firstPage: 2, lastPage: 2 });
    assert.match(second, /perplexity of 18\.2/);
  });

  test('recorded output stands in for pdftotext and keeps page ranges', async () => {
    const pdf = createPdfText({ recorded: { [pdfPath('doe2021sparse')]: recordedTextPath('doe2021sparse') } });
    assert.equal((await pdf.status()).available, true);
    assert.equal((await pdf.pages(pdfPath('doe2021sparse'))).length, 2);
    assert.match((await pdf.pages(pdfPath('doe2021sparse'), { firstPage: 2, lastPage: 2 }))[0], /^4 Results/);
    await assert.rejects(pdf.pages(pdfPath('lee2019recurrent')), { code: 'pdf_unreadable' });
  });

  test('without pdftotext it says so and reads nothing', async () => {
    const pdf = createPdfText({ command: '/nonexistent/pdftotext' });
    const status = await pdf.status();
    assert.equal(status.available, false);
    assert.match(status.reason, /not installed/);
    await assert.rejects(pdf.pages(pdfPath('doe2021sparse')), { code: 'pdftotext_unavailable' });
  });

  test('bad paths, pages, oversized files and output are refused', async () => {
    const pdf = createPdfText();
    await assert.rejects(pdf.pages('relative.pdf'), { code: 'invalid_path' });
    await assert.rejects(pdf.pages('/nonexistent/x.pdf'), { code: 'pdf_missing' });
    await assert.rejects(pdf.pages(pdfPath('doe2021sparse'), { firstPage: 0 }), { code: 'invalid_page' });
    await assert.rejects(pdf.pages(pdfPath('doe2021sparse'), { firstPage: 2, lastPage: 1 }), { code: 'invalid_page' });
    const small = createPdfText({ limits: { maxFileBytes: 100, maxOutputBytes: 10, maxPages: 10, timeoutMs: 10_000 } });
    await assert.rejects(small.pages(pdfPath('doe2021sparse')), { code: 'pdf_too_large' });
  });

  test('pdftotext output beyond the cap is refused, not truncated silently', { skip: needsPdftotext }, async () => {
    const pdf = createPdfText({ limits: { maxFileBytes: 1e6, maxOutputBytes: 50, maxPages: 10, timeoutMs: 10_000 } });
    await assert.rejects(pdf.pages(pdfPath('doe2021sparse')), { code: 'pdf_too_large' });
  });

  test('a file that is not a PDF is unreadable, not a crash', { skip: needsPdftotext }, async () => {
    const file = join(temp(), 'fake.pdf');
    writeFileSync(file, 'this is not a pdf');
    await assert.rejects(createPdfText().pages(file), { code: 'pdf_unreadable' });
  });
});
