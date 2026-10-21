import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { ingestLibrary } from '../../src/plugins/research/ingest.js';
import { createPdfText } from '../../src/plugins/research/pdf.js';
import { resetJobs } from '../../src/plugins/jobs.js';
import { betterBibtexPath, buildLibrary, pdfPath, recordedTextPath } from '../fixtures/research/build.js';
import { registeredSession, startServer } from '../helpers.js';

// Library → graph: the nodes, edges, privacy and external ids an ingest
// writes, that ingesting again updates rather than duplicates, that what
// leaves the library leaves the graph, and that a machine without pdftotext
// still ingests everything but the page text.

const noEmbed = async (texts) => texts.map(() => null);
const pdftotext = await createPdfText().status();

describe('research ingest', () => {
  let server;
  let api;
  let ownerId;
  const dirs = [];
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'research-ingest-'));
    dirs.push(dir);
    return dir;
  };
  // Recorded pdftotext output for the library's PDFs wherever they were laid out.
  const recordedFor = (lib) =>
    createPdfText({
      recorded: {
        [join(lib.storage, 'PDFA1111', 'doe2021sparse.pdf')]: recordedTextPath('doe2021sparse'),
        [join(lib.storage, 'PDFB2222', 'lee2019recurrent.pdf')]: recordedTextPath('lee2019recurrent'),
        [pdfPath('doe2021sparse')]: recordedTextPath('doe2021sparse'),
        [pdfPath('lee2019recurrent')]: recordedTextPath('lee2019recurrent'),
      },
    });

  const nodes = async (project) =>
    (await server.pool.query(
      `SELECT n.id, n.type, n.content, n.source, n.external_id, n.project, n.privacy, n.owner_id, r.kind, r.citekey, r.doi, r.page, r.chunk, r.text, r.paper_node_id, r.authors, r.year
         FROM nodes n LEFT JOIN research_items r ON r.node_id = n.id WHERE n.project = $1 ORDER BY n.external_id`,
      [project]
    )).rows;
  const edges = async (project, type) =>
    (await server.pool.query(
      `SELECT s.external_id AS "from", t.external_id AS "to" FROM node_relationships r
         JOIN nodes s ON s.id = r.source_id JOIN nodes t ON t.id = r.target_id
        WHERE r.type = $2 AND s.project = $1 ORDER BY 1, 2`,
      [project, type]
    )).rows;

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
  });
  after(async () => {
    resetJobs();
    dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    await server.close();
  });

  test('a Zotero library becomes papers, notes and page excerpts, linked and private by default', async () => {
    const lib = buildLibrary(temp());
    const progress = [];
    const summary = await ingestLibrary({ ownerId, path: lib.sqlite, project: 'lib-a', pdf: recordedFor(lib), embed: noEmbed, onProgress: (p) => progress.push(p) });
    assert.equal(summary.format, 'zotero-sqlite');
    assert.equal(summary.papers, 3);
    assert.equal(summary.notes, 1);
    assert.equal(summary.excerpts, 4, 'two pages for each of the two PDFs');
    assert.equal(summary.cites, 2);
    assert.deepEqual({ ...summary.pdfs, tool: undefined }, { read: 2, missing: 1, failed: 0, unavailable: 0, tool: undefined });
    assert.ok(summary.warnings.some((w) => /missing\.pdf/.test(w)), 'the missing attachment is a warning');
    assert.equal(progress.at(-1).itemsDone, 3);

    const rows = await nodes('lib-a');
    assert.ok(rows.every((row) => row.owner_id === ownerId && row.source === 'zotero' && row.privacy === 'local'));
    const papers = rows.filter((row) => row.type === 'paper');
    assert.deepEqual(papers.map((p) => p.citekey).sort(), ['doe2021sparse', 'kim2022survey', 'lee2019recurrent']);
    const doe = papers.find((p) => p.citekey === 'doe2021sparse');
    assert.equal(doe.external_id, 'lib-a/item/AAAA1111');
    assert.equal(doe.doi, '10.5555/fixture.0001');
    assert.deepEqual(doe.authors, ['Jane Doe', 'Rex Roe']);
    assert.match(doe.content, /^Sparse Attention for Long Documents\nJane Doe, Rex Roe \(2021\)\n@doe2021sparse · DOI 10\.5555\/fixture\.0001\nWe study/);

    const excerpts = rows.filter((row) => row.type === 'excerpt');
    assert.deepEqual(excerpts.map((e) => [e.citekey, e.page]), [['doe2021sparse', 1], ['doe2021sparse', 2], ['lee2019recurrent', 1], ['lee2019recurrent', 2]]);
    const results = excerpts.find((e) => e.citekey === 'doe2021sparse' && e.page === 2);
    assert.equal(results.external_id, 'lib-a/item/AAAA1111/pdf/PDFA1111/p2c0');
    assert.match(results.text, /^4 Results Our sparse model reaches a perplexity of 18\.2 on the LongText benchmark\./);
    assert.match(results.content, /^\[@doe2021sparse, p\. 2\] 4 Results/);
    assert.equal(results.paper_node_id, doe.id);

    const note = rows.find((row) => row.type === 'note');
    assert.equal(note.content, 'Note on @doe2021sparse (Sparse Attention for Long Documents): Key result: 18.2 perplexity on LongText & linear cost.');

    assert.deepEqual(await edges('lib-a', 'cites'), [
      { from: 'lib-a/item/CCCC3333', to: 'lib-a/item/AAAA1111' },
      { from: 'lib-a/item/CCCC3333', to: 'lib-a/item/BBBB2222' },
    ]);
    const partOf = await edges('lib-a', 'part_of');
    assert.equal(partOf.length, 5, 'four excerpts and one note');
    assert.ok(partOf.every((edge) => edge.to === 'lib-a/item/AAAA1111' || edge.to === 'lib-a/item/BBBB2222'));
  });

  test('ingesting again updates in place; what the library drops leaves the graph', async () => {
    const lib = buildLibrary(temp());
    const pdf = recordedFor(lib);
    await ingestLibrary({ ownerId, path: lib.sqlite, project: 'lib-b', pdf, embed: noEmbed });
    const first = await nodes('lib-b');

    // Same library, now shared with the cloud: same nodes, new privacy.
    const again = await ingestLibrary({ ownerId, path: lib.sqlite, project: 'lib-b', privacy: 'cloud', pdf, embed: noEmbed });
    assert.equal(again.pruned, 0);
    const second = await nodes('lib-b');
    assert.deepEqual(second.map((row) => row.id), first.map((row) => row.id), 'no duplicates, same ids');
    assert.ok(second.every((row) => row.privacy === 'cloud'));

    // The survey goes to the trash and the relation to Lee is removed.
    const db = new DatabaseSync(lib.sqlite);
    db.exec("INSERT INTO deletedItems (itemID) VALUES (3); DELETE FROM itemNotes WHERE itemID = 6;");
    db.close();
    const third = await ingestLibrary({ ownerId, path: lib.sqlite, project: 'lib-b', pdf, embed: noEmbed });
    assert.equal(third.papers, 2);
    assert.equal(third.pruned, 2, 'the trashed paper and the deleted note');
    const left = await nodes('lib-b');
    assert.ok(!left.some((row) => row.citekey === 'kim2022survey'));
    assert.ok(!left.some((row) => row.type === 'note'));
    assert.deepEqual(await edges('lib-b', 'cites'), [], 'edges go with the paper');
    const orphans = await server.pool.query('SELECT count(*)::int AS c FROM research_items r LEFT JOIN nodes n ON n.id = r.node_id WHERE n.id IS NULL');
    assert.equal(orphans.rows[0].c, 0);
  });

  test('without pdftotext papers and notes still ingest, and existing page text is kept', async () => {
    const lib = buildLibrary(temp());
    const missing = createPdfText({ command: '/nonexistent/pdftotext' });
    const fresh = await ingestLibrary({ ownerId, path: lib.sqlite, project: 'lib-c', pdf: missing, embed: noEmbed });
    assert.equal(fresh.papers, 3);
    assert.equal(fresh.excerpts, 0);
    assert.equal(fresh.pdfs.tool.available, false);
    assert.equal(fresh.pdfs.unavailable, 3, 'every attachment, even the missing one, is unread');
    assert.match(fresh.warnings[0], /PDF text was not extracted: .*not installed/);
    assert.equal((await nodes('lib-c')).filter((row) => row.type === 'excerpt').length, 0);

    await ingestLibrary({ ownerId, path: lib.sqlite, project: 'lib-c', pdf: recordedFor(lib), embed: noEmbed });
    assert.equal((await nodes('lib-c')).filter((row) => row.type === 'excerpt').length, 4);
    const later = await ingestLibrary({ ownerId, path: lib.sqlite, project: 'lib-c', pdf: missing, embed: noEmbed });
    assert.equal(later.pruned, 0);
    assert.equal((await nodes('lib-c')).filter((row) => row.type === 'excerpt').length, 4, 'a missing tool loses nothing already read');
  });

  test('a Better BibTeX export ingests the same papers, plus standalone notes', async () => {
    const summary = await ingestLibrary({ ownerId, path: betterBibtexPath, project: 'lib-d', pdf: recordedFor({ storage: '/none' }), embed: noEmbed });
    assert.equal(summary.format, 'better-bibtex');
    assert.equal(summary.papers, 3);
    assert.equal(summary.notes, 2);
    assert.equal(summary.excerpts, 4);
    const standalone = (await nodes('lib-d')).find((row) => row.external_id === 'lib-d/note/NOTE9999');
    assert.equal(standalone.content, 'Note: Standalone note: compare memory and sparsity on LongText.');
    assert.equal(standalone.paper_node_id, null);
  });

  test('bad arguments are refused before anything is read', async () => {
    await assert.rejects(ingestLibrary({ ownerId, path: betterBibtexPath, privacy: 'public', embed: noEmbed }), { code: 'invalid_input' });
    await assert.rejects(ingestLibrary({ ownerId, path: betterBibtexPath, project: ' ', embed: noEmbed }), { code: 'invalid_input' });
    await assert.rejects(ingestLibrary({ path: betterBibtexPath, embed: noEmbed }), { code: 'invalid_input' });
  });

  test('another owner’s ingest of the same library is separate', async () => {
    const other = await registeredSession(server.base);
    const { data: { userId: otherId } } = await other('GET', '/api/auth/session');
    await ingestLibrary({ ownerId: otherId, path: betterBibtexPath, project: 'lib-a', pdf: recordedFor({ storage: '/none' }), embed: noEmbed });
    const { rows } = await server.pool.query("SELECT owner_id, count(*)::int AS c FROM nodes WHERE project = 'lib-a' AND type = 'paper' GROUP BY owner_id ORDER BY 2");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.c === 3));
  });

  describe('ingest route', () => {
    const poll = async (session, id) => {
      for (let i = 0; i < 200; i += 1) {
        const { data } = await session('GET', `/api/plugins/research/jobs/${id}`);
        if (data.state !== 'running') return data;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('ingest job did not finish');
    };

    test('needs a session', async () => {
      const response = await fetch(`${server.base}/api/plugins/research/status`);
      assert.equal(response.status, 401);
    });

    test('reports whether PDFs can be read', async () => {
      const { status, data } = await api('GET', '/api/plugins/research/status');
      assert.equal(status, 200);
      assert.equal(data.pdftotext.available, pdftotext.available);
    });

    test('validates the request', async () => {
      for (const body of [{}, { path: 'relative.sqlite' }, { path: '/x.sqlite', privacy: 'public' }, { path: '/x.sqlite', project: '' }, { path: '/x.sqlite', storageDir: 'rel' }]) {
        const { status, data } = await api('POST', '/api/plugins/research/ingest', body);
        assert.equal(status, 400, JSON.stringify(body));
        assert.equal(data.error, 'invalid_input');
      }
    });

    test('runs an ingest as a job the client polls; a bad file fails the job, not the request', async () => {
      const lib = buildLibrary(temp());
      const started = await api('POST', '/api/plugins/research/ingest', { path: lib.sqlite, project: 'via-route' });
      assert.equal(started.status, 202);
      assert.equal(started.data.kind, 'research.ingest');
      const busy = await api('POST', '/api/plugins/research/ingest', { path: lib.sqlite });
      assert.equal(busy.status, 409);
      const done = await poll(api, started.data.id);
      assert.equal(done.state, 'done', done.error);
      assert.equal(done.summary.papers, 3);
      assert.equal(done.summary.excerpts, pdftotext.available ? 4 : 0);
      assert.equal(done.summary.privacy, 'local');

      const bad = await api('POST', '/api/plugins/research/ingest', { path: join(temp(), 'missing.sqlite') });
      assert.equal(bad.status, 202);
      const failed = await poll(api, bad.data.id);
      assert.equal(failed.state, 'failed');
      assert.match(failed.error, /not a file/);

      const other = await registeredSession(server.base);
      assert.equal((await other('GET', `/api/plugins/research/jobs/${started.data.id}`)).status, 404, 'a job is its owner’s');
    });
  });
});
