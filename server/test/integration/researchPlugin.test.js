import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { registerBuiltInPlugins } from '../../src/plugins/registry.js';
import { createResearchPlugin } from '../../src/plugins/research/index.js';
import { ingestLibrary } from '../../src/plugins/research/ingest.js';
import { createPdfText } from '../../src/plugins/research/pdf.js';
import { searxngProvider } from '../../src/plugins/research/webSearch.js';
import { capabilitiesForTags, getCapability, getVerifier, listPlugins } from '../../src/workspace/capabilities.js';
import { createEventBus } from '../../src/workspace/events.js';
import { createWorker } from '../../src/workspace/runner/index.js';
import { roleTemplate } from '../../src/workspace/roles.js';
import { createFakeModelPort } from '../fakeModelPort.js';
import { betterBibtexPath, buildLibrary, pdfPath, recordedTextPath } from '../fixtures/research/build.js';
import { registeredSession, startServer } from '../helpers.js';

// The research capabilities and verifiers over an ingested library, called
// directly with a runner-shaped ctx, and then end to end through the runner.

const noEmbed = async (texts) => texts.map(() => null);

const DOE_RESULT = 'reaches a perplexity of 18.2 on the LongText benchmark';
const GOOD_PARAGRAPH =
  `Sparse attention keeps long inputs affordable: the sparse model "${DOE_RESULT}" [@doe2021sparse, p. 2]. ` +
  'A recurrent memory instead reads an unbounded stream with constant memory [@lee2019recurrent].';

describe('research plug-in', () => {
  let server;
  let ownerId;
  let otherOwnerId;
  let plugin;
  let model;
  let web;
  const dirs = [];
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'research-plugin-'));
    dirs.push(dir);
    return dir;
  };

  const agent = (overrides = {}) => ({
    state: 'active',
    level: 'supervised',
    modelPolicy: 'local_only',
    overrides: {},
    scopes: { read: { projects: ['*'], sources: ['zotero'] }, write: { projects: ['*'] } },
    ...overrides,
  });
  const ctxFor = (extra = {}) => ({ ownerId, agent: agent(), project: 'papers', model, signal: new AbortController().signal, ...extra });
  const cap = (name) => plugin.capabilities.find((capability) => capability.name === name);
  const run = (name, input, ctx = ctxFor()) => cap(name).run(input, ctx);
  const verifier = (name) => plugin.verifiers.find((entry) => entry.name === name);
  const verify = async (result, ctx = ctxFor()) => ({
    citations: await verifier('research.citations_resolve').verify(result, ctx),
    quotes: await verifier('research.quotes_match').verify(result, ctx),
  });
  const paperId = async (project, citekey) =>
    (await server.pool.query("SELECT n.id FROM nodes n JOIN research_items r ON r.node_id = n.id WHERE n.project = $1 AND r.citekey = $2 AND r.kind = 'paper' AND n.owner_id = $3", [project, citekey, ownerId])).rows[0].id;

  before(async () => {
    server = await startServer();
    const api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
    const other = await registeredSession(server.base);
    ({ data: { userId: otherOwnerId } } = await other('GET', '/api/auth/session'));

    const lib = buildLibrary(temp());
    const recorded = createPdfText({
      recorded: {
        [join(lib.storage, 'PDFA1111', 'doe2021sparse.pdf')]: recordedTextPath('doe2021sparse'),
        [join(lib.storage, 'PDFB2222', 'lee2019recurrent.pdf')]: recordedTextPath('lee2019recurrent'),
        [pdfPath('doe2021sparse')]: recordedTextPath('doe2021sparse'),
        [pdfPath('lee2019recurrent')]: recordedTextPath('lee2019recurrent'),
      },
    });
    // 'papers' is a private library; 'open' the same papers shared with the
    // cloud; 'notext' was ingested where pdftotext was missing.
    await ingestLibrary({ ownerId, path: lib.sqlite, project: 'papers', pdf: recorded, embed: noEmbed });
    await ingestLibrary({ ownerId, path: betterBibtexPath, project: 'open', privacy: 'cloud', pdf: recorded, embed: noEmbed });
    await ingestLibrary({ ownerId, path: lib.sqlite, project: 'notext', pdf: createPdfText({ command: '/nonexistent/pdftotext' }), embed: noEmbed });
    await ingestLibrary({ ownerId: otherOwnerId, path: lib.sqlite, project: 'theirs', pdf: recorded, embed: noEmbed });
    plugin = createResearchPlugin({ pdf: recorded, webSearchProvider: null });
  });

  beforeEach(() => {
    model = createFakeModelPort({ name: 'local' });
  });

  after(async () => {
    dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    await server.close();
  });

  describe('registration', () => {
    test('registers through the built-in registry, once, with its verifiers', () => {
      registerBuiltInPlugins();
      registerBuiltInPlugins();
      assert.equal(listPlugins().filter((name) => name === 'research').length, 1);
      for (const name of ['research.sweep', 'research.extract', 'research.related_work']) {
        assert.equal(getCapability(name).permission, 'read_graph');
        assert.equal(getCapability(name).source, 'zotero', 'can() is asked about the library source');
        assert.deepEqual(getCapability(name).verifiers, ['research.citations_resolve', 'research.quotes_match']);
      }
      assert.equal(getCapability('research.web_search').permission, 'web');
      assert.ok(getVerifier('research.citations_resolve') && getVerifier('research.quotes_match'));
    });

    test('the Researcher role reaches every research capability through its tags', () => {
      const names = (tags) => capabilitiesForTags(tags).map((c) => c.name).filter((n) => n.startsWith('research.')).sort();
      assert.deepEqual(names(roleTemplate('researcher').tags), ['research.extract', 'research.related_work', 'research.sweep', 'research.web_search']);
      assert.deepEqual(names(['web']), ['research.web_search']);
      assert.deepEqual(names(roleTemplate('builder').tags), []);
    });
  });

  describe('research.sweep', () => {
    test('ranks papers for a question with the excerpts that support them', async () => {
      const result = await run('research.sweep', { question: 'sparse attention perplexity on LongText', project: 'papers' });
      const { papers } = result.output;
      assert.equal(papers[0].citekey, 'doe2021sparse');
      assert.deepEqual(papers.map((p) => p.citekey).sort(), ['doe2021sparse', 'kim2022survey', 'lee2019recurrent']);
      assert.ok(papers[0].score > papers[1].score);
      const best = papers[0].excerpts[0];
      assert.equal(best.page, 2);
      assert.match(best.text, /perplexity of 18\.2/);
      assert.deepEqual(papers.find((p) => p.citekey === 'kim2022survey').excerpts, [], 'matched on its abstract; it has no page text');
      assert.ok(result.touchedNodeIds.includes(papers[0].paperId) && result.touchedNodeIds.includes(best.excerptId));
      assert.match(result.artifacts[0].content, /^Literature sweep: sparse attention/);
      assert.match(result.artifacts[0].content, /\[@doe2021sparse\] doi:10\.5555\/fixture\.0001/);
      assert.match(result.findings[0], /@doe2021sparse/);
      const checks = await verify(result);
      assert.equal(checks.citations.ok, true, checks.citations.detail);
      assert.equal(checks.quotes.ok, true, checks.quotes.detail);
      assert.equal(checks.quotes.unavailable, undefined);
    });

    test('is deterministic', async () => {
      const a = await run('research.sweep', { question: 'recurrent memory GPUs' });
      const b = await run('research.sweep', { question: 'recurrent memory GPUs' });
      assert.deepEqual(a.output, b.output);
    });

    test('limits to named papers and to the counts asked for', async () => {
      const named = await run('research.sweep', { question: 'perplexity', papers: ['@lee2019recurrent'], project: 'papers' });
      assert.deepEqual(named.output.papers.map((p) => p.citekey), ['lee2019recurrent']);
      const one = await run('research.sweep', { question: 'perplexity benchmark', maxPapers: 1, excerptsPerPaper: 1, project: 'papers' });
      assert.equal(one.output.papers.length, 1);
      assert.equal(one.output.papers[0].excerpts.length, 1);
    });

    test('reads only what the agent may read, and only its owner’s library', async () => {
      const narrow = ctxFor({ agent: agent({ scopes: { read: { projects: ['open'], sources: ['zotero'] }, write: { projects: [] } } }) });
      const result = await run('research.sweep', { question: 'perplexity' }, narrow);
      assert.ok(result.output.papers.length > 0);
      assert.ok(result.output.papers.every((p) => p.project === 'open'));
      await assert.rejects(run('research.sweep', { question: 'perplexity', project: 'papers' }, narrow), { code: 'outside_read_scope' });
      const noSource = ctxFor({ agent: agent({ scopes: { read: { projects: ['*'], sources: ['github'] }, write: { projects: [] } } }) });
      assert.deepEqual((await run('research.sweep', { question: 'perplexity' }, noSource)).output.papers, []);
      const all = await run('research.sweep', { question: 'perplexity', maxPapers: 50 });
      assert.ok(!all.output.papers.some((p) => p.project === 'theirs'));
      await assert.rejects(run('research.sweep', { question: 'perplexity' }, ctxFor({ agent: null })), { code: 'no_agent' });
    });

    test('refuses bad input', async () => {
      await assert.rejects(run('research.sweep', { question: '' }), { code: 'invalid_input' });
      await assert.rejects(run('research.sweep', { question: 'the of and' }), { code: 'invalid_input' });
      await assert.rejects(run('research.sweep', { question: 'x y', maxPapers: 0 }), { code: 'invalid_input' });
      await assert.rejects(run('research.sweep', { question: 'perplexity', papers: ['nobody1999'] }), { code: 'unknown_papers' });
      assert.deepEqual((await run('research.sweep', { question: 'quantum chromodynamics' })).output.papers, []);
    });
  });

  describe('research.extract', () => {
    const COLUMNS = ['perplexity', { name: 'compute', question: 'how many GPUs and days of training' }];
    const reply = (cells) => ({ cells });

    test('fills a row per paper; each kept cell carries its excerpt, page and verbatim quote', async () => {
      model.push(
        (request) => {
          assert.match(request.messages[1].content, /\[@doe2021sparse\]/);
          assert.match(request.messages[1].content, /E1 \(p\. 2\): 4 Results/);
          return reply({
            perplexity: { value: '18.2', excerpt: 'E1', quote: DOE_RESULT },
            compute: { value: '8 GPUs for 3 days', excerpt: 'E1', quote: 'trained on 8 GPUs for 3 days' },
          });
        },
        reply({
          perplexity: { value: '19.5', excerpt: 'E1', quote: 'the recurrent memory reaches a perplexity of 19.5' },
          // Not what the excerpt says: dropped, not kept.
          compute: { value: '16 GPUs', excerpt: 'E1', quote: 'Training took 2 days on 16 GPUs' },
        })
      );
      const result = await run('research.extract', { columns: COLUMNS, papers: ['doe2021sparse', '10.5555/FIXTURE.0002', 'kim2022survey'], project: 'papers' });
      assert.equal(model.calls.length, 2, 'no call for a paper with no matching excerpt');
      const [doe, lee, kim] = result.output.rows;
      assert.equal(doe.cells.perplexity.value, '18.2');
      assert.equal(doe.cells.perplexity.page, 2);
      assert.equal(doe.cells.compute.status, 'supported');
      assert.equal(lee.cells.perplexity.value, '19.5');
      assert.equal(lee.cells.compute.status, 'unsupported');
      assert.equal(lee.cells.compute.value, null);
      assert.equal(kim.cells.perplexity.status, 'not_found');
      assert.equal(result.output.supported, 3);
      const table = result.artifacts[0].content;
      assert.match(table, /^\| Paper \| perplexity \| compute \|/);
      assert.match(table, /\| Sparse Attention for Long Documents \[@doe2021sparse\] \| 18\.2 \(p\. 2\) \| 8 GPUs for 3 days \(p\. 2\) \|/);
      assert.match(table, /\| Recurrent Memory for Streaming Text \[@lee2019recurrent\] \| 19\.5 \(p\. 2\) \| — \|/);
      assert.match(table, /- perplexity, @doe2021sparse: "reaches a perplexity of 18\.2 on the LongText benchmark" \[@doe2021sparse, p\. 2\]/);
      const checks = await verify(result);
      assert.equal(checks.citations.ok, true, checks.citations.detail);
      assert.equal(checks.quotes.ok, true, checks.quotes.detail);
      assert.match(checks.quotes.detail, /match their source verbatim/);
    });

    test('a reply that is not the JSON asked for leaves every cell unsupported', async () => {
      model.push('Sure! The perplexity is 18.2.');
      const result = await run('research.extract', { columns: ['perplexity'], papers: ['doe2021sparse'], project: 'papers' });
      assert.equal(result.output.rows[0].cells.perplexity.status, 'unsupported');
      assert.equal(result.output.supported, 0);
    });

    test('finds the papers from a question when none are named', async () => {
      const fallbackModel = createFakeModelPort({ name: 'local', fallback: reply({ perplexity: null }) });
      const result = await run('research.extract', { columns: ['perplexity'], question: 'LongText benchmark', maxPapers: 2, project: 'papers' }, ctxFor({ model: fallbackModel }));
      assert.equal(result.output.rows.length, 2);
      assert.ok(result.output.rows.every((row) => row.cells.perplexity.status === 'not_found'));
    });

    test('private excerpts never go to a model the agent could route to the cloud', async () => {
      const cloudCapable = createFakeModelPort({ name: 'platform', fallback: reply({ perplexity: null }) });
      const ctx = ctxFor({ agent: agent({ modelPolicy: 'local_cloud', overrides: { cloud_model: 'allow' } }), model: cloudCapable });
      await assert.rejects(run('research.extract', { columns: ['perplexity'], papers: ['doe2021sparse'], project: 'papers' }, ctx), { code: 'private_sources' });
      assert.equal(cloudCapable.calls.length, 0, 'nothing was sent');
      // The same papers ingested as cloud may go; so may private ones when the
      // engine is offline or cloud_model is denied by override.
      await run('research.extract', { columns: ['perplexity'], papers: ['doe2021sparse'], project: 'open' }, ctx);
      assert.equal(cloudCapable.calls.length, 1);
      const denied = ctxFor({ agent: agent({ modelPolicy: 'local_cloud', overrides: { cloud_model: 'deny' } }), model: cloudCapable });
      await run('research.extract', { columns: ['perplexity'], papers: ['doe2021sparse'], project: 'papers' }, denied);
      assert.equal(cloudCapable.calls.length, 2);
    });

    test('refuses bad input', async () => {
      await assert.rejects(run('research.extract', { columns: [] }), { code: 'invalid_input' });
      await assert.rejects(run('research.extract', { columns: ['a', 'A'], papers: ['doe2021sparse'] }), /unique/);
      await assert.rejects(run('research.extract', { columns: ['perplexity'] }), /name the papers/);
      await assert.rejects(run('research.extract', { columns: [{ question: 'no name' }], papers: ['doe2021sparse'] }), { code: 'invalid_input' });
    });
  });

  describe('research.related_work', () => {
    test('drafts from the excerpts only, and the draft verifies', async () => {
      model.push((request) => {
        const prompt = request.messages[1].content;
        assert.match(prompt, /\[@doe2021sparse\] Sparse Attention for Long Documents/);
        assert.match(prompt, /p\. 2: 4 Results Our sparse model reaches/);
        assert.doesNotMatch(prompt, /kim2022survey/, 'a paper with no page text is not offered');
        assert.match(request.messages[0].content, /at most 120 words/);
        return GOOD_PARAGRAPH;
      });
      const result = await run('research.related_work', { topic: 'perplexity of long-context models on LongText', maxWords: 120, project: 'papers' });
      assert.equal(result.output.paragraph, GOOD_PARAGRAPH);
      assert.deepEqual(result.output.citations.map((c) => c.citekey), ['doe2021sparse', 'lee2019recurrent']);
      assert.deepEqual(result.output.quotes, [{ text: DOE_RESULT, citekey: 'doe2021sparse', page: 2 }]);
      assert.match(result.artifacts[0].content, /References:\n- @doe2021sparse: Sparse Attention for Long Documents \(Jane Doe and Rex Roe, 2021\)\. doi:10\.5555\/fixture\.0001/);
      const checks = await verify(result);
      assert.equal(checks.citations.ok, true, checks.citations.detail);
      assert.equal(checks.quotes.ok, true, checks.quotes.detail);
    });

    const draft = async (paragraph) => {
      model.push(paragraph);
      const result = await run('research.related_work', { topic: 'perplexity on LongText', project: 'papers' });
      return { result, checks: await verify(result) };
    };

    test('a citation outside the library, or to a paper it was not given, fails verification', async () => {
      let { checks } = await draft('Memory helps [@lee2019recurrent], as does magic [@nobody2020].');
      assert.equal(checks.citations.ok, false);
      assert.match(checks.citations.detail, /not in the library: @nobody2020/);
      ({ checks } = await draft('Surveys exist [@kim2022survey] and memory helps [@lee2019recurrent].'));
      assert.equal(checks.citations.ok, false);
      assert.match(checks.citations.detail, /cited without an excerpt given for it: @kim2022survey/);
      ({ checks } = await draft('Attention is cheap now.'));
      assert.equal(checks.citations.ok, false);
      assert.match(checks.citations.detail, /cites nothing/);
    });

    test('a misquote, a wrong page or an unattributed quotation fails verification', async () => {
      let { checks } = await draft('It "reaches a perplexity of 17.0 on the LongText benchmark" [@doe2021sparse, p. 2].');
      assert.equal(checks.quotes.ok, false);
      assert.match(checks.quotes.detail, /is not in @doe2021sparse, p\. 2/);
      ({ checks } = await draft(`It "${DOE_RESULT}" [@doe2021sparse, p. 1].`));
      assert.equal(checks.quotes.ok, false);
      assert.match(checks.quotes.detail, /not on p\. 1 \(found on p\. 2\)/);
      ({ checks } = await draft(`Memory "reaches a perplexity of 19.5" [@lee2019recurrent, p. 2] and "is all you need for streams" in general [@lee2019recurrent].`));
      assert.equal(checks.quotes.ok, false);
      assert.match(checks.quotes.detail, /1 of 2 quotations/);
      ({ checks } = await draft(`A model "${DOE_RESULT}" [@doe2021sparse, p. 2] and "quoted from nowhere at all" as well.`));
      assert.equal(checks.quotes.ok, false);
      assert.match(checks.quotes.detail, /"quoted from nowhere at all" is not in the cited papers/);
    });

    test('an elided quotation and an uncited one from a cited paper pass', async () => {
      const { checks } = await draft('The model "Our sparse model ... LongText benchmark" [@doe2021sparse, p. 2]; and "trained on 8 GPUs for 3 days" too.');
      assert.equal(checks.quotes.ok, true, checks.quotes.detail);
    });

    test('nothing to ground on, or nothing drafted, is an error', async () => {
      await assert.rejects(run('research.related_work', { topic: 'quantum chromodynamics', project: 'papers' }), { code: 'no_excerpts' });
      await assert.rejects(run('research.related_work', { topic: 'perplexity', project: 'notext' }), { code: 'no_excerpts' });
      model.push('<think>hmm</think>');
      await assert.rejects(run('research.related_work', { topic: 'perplexity', project: 'papers' }), { code: 'empty_draft' });
      await assert.rejects(run('research.related_work', { topic: 'perplexity', maxWords: 10 }), { code: 'invalid_input' });
    });
  });

  describe('verifiers', () => {
    test('citations resolve by DOI too, and an unknown DOI fails', async () => {
      let outcome = await verifier('research.citations_resolve').verify({ output: {}, artifacts: [{ content: 'See doi:10.5555/FIXTURE.0001 and https://doi.org/10.5555/fixture.0002.' }] }, ctxFor());
      assert.equal(outcome.ok, true, outcome.detail);
      outcome = await verifier('research.citations_resolve').verify({ output: { citations: [{ doi: '10.5555/unknown.9' }] } }, ctxFor());
      assert.equal(outcome.ok, false);
      assert.match(outcome.detail, /10\.5555\/unknown\.9/);
      outcome = await verifier('research.citations_resolve').verify({ output: { note: 'nothing cited' } }, ctxFor());
      assert.deepEqual(outcome, { ok: true, detail: 'nothing is cited' });
    });

    test('citations resolve only within the agent’s read scope', async () => {
      const narrow = ctxFor({ agent: agent({ scopes: { read: { projects: ['nowhere'], sources: ['zotero'] }, write: { projects: [] } } }) });
      const outcome = await verifier('research.citations_resolve').verify({ output: { citations: ['doe2021sparse'] } }, narrow);
      assert.equal(outcome.ok, false);
    });

    test('a quote naming an excerpt is checked against that excerpt and its page', async () => {
      const sweep = await run('research.sweep', { question: 'perplexity', papers: ['doe2021sparse'], project: 'papers' });
      const excerpt = sweep.output.papers[0].excerpts[0];
      const check = (quote) => verifier('research.quotes_match').verify({ output: { quotes: [quote] } }, ctxFor());
      assert.equal((await check({ text: DOE_RESULT, excerptId: excerpt.excerptId, page: 2 })).ok, true);
      assert.match((await check({ text: DOE_RESULT, excerptId: excerpt.excerptId, page: 1 })).detail, /excerpt is on p\. 2, not p\. 1/);
      assert.match((await check({ text: 'not in it at all', excerptId: excerpt.excerptId })).detail, /not in the excerpt it cites/);
      const theirs = (await server.pool.query("SELECT n.id FROM nodes n WHERE n.project = 'theirs' AND n.type = 'excerpt' LIMIT 1")).rows[0].id;
      assert.match((await check({ text: DOE_RESULT, excerptId: theirs })).detail, /not in the library/, 'another owner’s excerpt is not this library');
    });

    test('a paper without stored page text is checked against its PDF, or reported unchecked when pdftotext is missing', async () => {
      const ctx = ctxFor({ agent: agent({ scopes: { read: { projects: ['notext'], sources: ['zotero'] }, write: { projects: [] } } }) });
      const quote = { output: { quotes: [{ text: DOE_RESULT, citekey: 'doe2021sparse', page: 2 }] } };
      // The recorded pdftotext stands in for the tool: the page is read now.
      const live = createResearchPlugin({
        pdf: createPdfText({ recorded: Object.fromEntries((await server.pool.query("SELECT r.attachments FROM research_items r JOIN nodes n ON n.id = r.node_id WHERE n.project = 'notext' AND r.citekey = 'doe2021sparse' AND r.kind = 'paper'")).rows[0].attachments.map((a) => [a.path, recordedTextPath('doe2021sparse')])) }),
        webSearchProvider: null,
      });
      const ok = await live.verifiers.find((v) => v.name === 'research.quotes_match').verify(quote, ctx);
      assert.equal(ok.ok, true, ok.detail);
      assert.equal(ok.unavailable, undefined);
      const wrong = await live.verifiers.find((v) => v.name === 'research.quotes_match').verify({ output: { quotes: [{ text: 'a perplexity of 99', citekey: 'doe2021sparse', page: 2 }] } }, ctx);
      assert.equal(wrong.ok, false);

      const noTool = createResearchPlugin({ pdf: createPdfText({ command: '/nonexistent/pdftotext' }), webSearchProvider: null });
      const unchecked = await noTool.verifiers.find((v) => v.name === 'research.quotes_match').verify(quote, ctx);
      assert.equal(unchecked.ok, true);
      assert.equal(unchecked.unavailable, true);
      assert.match(unchecked.detail, /could not be checked: .*not installed/);
    });

    test('no quotations is a pass with nothing checked', async () => {
      assert.deepEqual(await verifier('research.quotes_match').verify({ output: {} }, ctxFor()), { ok: true, detail: 'no quotations to check' });
    });
  });

  describe('research.web_search', () => {
    const fakeProvider = (results) => ({
      name: 'fake',
      calls: [],
      async search(request) {
        this.calls.push(request);
        if (results instanceof Error) throw results;
        return results;
      },
    });
    const withProvider = (provider) => createResearchPlugin({ pdf: createPdfText({ recorded: {} }), webSearchProvider: provider }).capabilities.find((c) => c.name === 'research.web_search');

    test('returns cleaned results from the configured provider', async () => {
      const provider = fakeProvider([
        { title: 'Sparse attention', url: 'https://example.org/sparse', snippet: 'about   sparse\nattention' },
        { title: 'Evil', url: 'javascript:alert(1)', snippet: 'x' },
        { title: 'Local', url: 'file:///etc/passwd' },
        { url: 'http://example.org/untitled' },
      ]);
      const result = await withProvider(provider).run({ query: 'sparse attention', maxResults: 3 }, ctxFor({ model: createFakeModelPort({ name: 'platform' }) }));
      assert.deepEqual(provider.calls[0].query, 'sparse attention');
      assert.equal(provider.calls[0].maxResults, 3);
      assert.deepEqual(result.output.results, [
        { title: 'Sparse attention', url: 'https://example.org/sparse', snippet: 'about sparse attention' },
        { title: 'example.org', url: 'http://example.org/untitled', snippet: '' },
      ]);
      assert.match(result.artifacts[0].content, /1\. Sparse attention\n {3}https:\/\/example\.org\/sparse/);
    });

    test('without a provider it refuses cleanly', async () => {
      await assert.rejects(withProvider(null).run({ query: 'x' }, ctxFor({ model: createFakeModelPort({ name: 'platform' }) })), { code: 'web_search_unavailable' });
    });

    test('offline it refuses before asking the provider', async () => {
      const provider = fakeProvider([]);
      await assert.rejects(withProvider(provider).run({ query: 'x' }, ctxFor()), { code: 'offline' });
      assert.equal(provider.calls.length, 0);
    });

    test('a provider failure is a capability error', async () => {
      await assert.rejects(withProvider(fakeProvider(new Error('boom'))).run({ query: 'x' }, ctxFor({ model: createFakeModelPort({ name: 'platform' }) })), { code: 'web_search_failed', message: /fake failed: boom/ });
      await assert.rejects(withProvider(fakeProvider({ not: 'a list' })).run({ query: 'x' }, ctxFor({ model: createFakeModelPort({ name: 'platform' }) })), { code: 'web_search_failed' });
    });

    test('the SearXNG provider asks its JSON API and maps the results', async () => {
      const requests = [];
      const provider = searxngProvider({
        baseUrl: 'http://searx.test/base',
        fetchImpl: async (url) => {
          requests.push(String(url));
          return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://example.org/t', content: 'S' }, { title: 'U', url: 'https://example.org/u', content: '' }] }), { status: 200 });
        },
      });
      assert.deepEqual(await provider.search({ query: 'a b', maxResults: 1 }), [{ title: 'T', url: 'https://example.org/t', snippet: 'S' }]);
      assert.equal(requests[0], 'http://searx.test/base/search?q=a+b&format=json');
      const failing = searxngProvider({ baseUrl: 'http://searx.test', fetchImpl: async () => new Response('no', { status: 503 }) });
      await assert.rejects(failing.search({ query: 'x', maxResults: 1 }), /answered 503/);
    });
  });

  describe('through the runner', () => {
    let bus;
    let local;
    const workers = [];
    const choose = (capability, input, summary = `use ${capability}`) => ({ capability, input, summary });

    async function researcher({ level = 'supervised', sources = ['zotero'] } = {}) {
      const { rows } = await server.pool.query(
        `INSERT INTO agents (owner_id, name, role, level, scopes, model_policy) VALUES ($1, 'Researcher', $2, $3, $4, 'local_only') RETURNING id`,
        [ownerId, roleTemplate('researcher'), level, { read: { projects: ['papers'], sources }, write: { projects: ['papers'] } }]
      );
      return rows[0].id;
    }
    const makeRun = async (agentId, instructions) =>
      (await server.pool.query('INSERT INTO agent_runs (owner_id, agent_id, instructions, project) VALUES ($1, $2, $3, $4) RETURNING id', [ownerId, agentId, instructions, 'papers'])).rows[0].id;
    const steps = async (runId) => (await server.pool.query('SELECT * FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [runId])).rows;
    const runRow = async (runId) => (await server.pool.query('SELECT * FROM agent_runs WHERE id = $1', [runId])).rows[0];
    const worker = (options = {}) => {
      const instance = createWorker({ adapters: { local }, events: bus, embed: false, leaseMs: 30_000, heartbeatMs: 25, onError: () => {}, ...options });
      workers.push(instance);
      return instance;
    };

    beforeEach(() => {
      for (const instance of workers.splice(0)) instance.abandon();
      bus = createEventBus();
      local = createFakeModelPort({ name: 'local' });
    });
    after(() => {
      for (const instance of workers.splice(0)) instance.abandon();
    });

    test('a Researcher sweeps, drafts related work, and the verified draft is written back', async () => {
      const agentId = await researcher();
      const runId = await makeRun(agentId, 'Draft a related-work paragraph on perplexity on LongText');
      local.push(
        '1. Sweep the library.\n2. Draft the paragraph.',
        choose('research.sweep', { question: 'perplexity on LongText' }),
        choose('research.related_work', { topic: 'perplexity on LongText' }),
        GOOD_PARAGRAPH,
        { done: true, summary: 'Drafted the related-work paragraph.' }
      );
      await worker().drain();
      const run = await runRow(runId);
      assert.equal(run.status, 'succeeded', run.error);
      const rows = await steps(runId);
      assert.deepEqual(rows.map((s) => [s.capability, s.status]), [[null, 'done'], ['research.sweep', 'done'], ['research.related_work', 'done'], [null, 'done']]);
      assert.deepEqual(rows[2].verification.map((v) => [v.verifier, v.ok]), [['result.schema', true], ['research.citations_resolve', true], ['research.quotes_match', true]]);
      const artifacts = (await server.pool.query("SELECT content FROM nodes WHERE owner_id = $1 AND type = 'artifact' AND source = 'agent' AND content LIKE 'Related work:%'", [ownerId])).rows;
      assert.equal(artifacts.length, 1);
      assert.match(artifacts[0].content, /\[@doe2021sparse, p\. 2\]/);
    });

    test('a draft with a fabricated quotation fails its step and writes nothing back', async () => {
      const agentId = await researcher();
      const runId = await makeRun(agentId, 'Draft related work');
      local.push(
        'Draft it.',
        choose('research.related_work', { topic: 'perplexity on LongText' }),
        'The model "reaches a perplexity of 12.0 on everything" [@doe2021sparse, p. 2].',
        { done: true, summary: 'Gave up.' }
      );
      const before = (await server.pool.query("SELECT count(*)::int AS c FROM nodes WHERE owner_id = $1 AND type = 'artifact'", [ownerId])).rows[0].c;
      await worker().drain();
      const rows = await steps(runId);
      assert.equal(rows[1].status, 'failed');
      assert.equal(rows[1].error, 'verification_failed');
      const quotes = rows[1].verification.find((v) => v.verifier === 'research.quotes_match');
      assert.equal(quotes.ok, false);
      assert.match(quotes.detail, /12\.0/);
      const afterCount = (await server.pool.query("SELECT count(*)::int AS c FROM nodes WHERE owner_id = $1 AND type = 'artifact'", [ownerId])).rows[0].c;
      assert.equal(afterCount, before);
    });

    test('an agent that may not read the library is denied before the capability runs', async () => {
      const agentId = await researcher({ sources: ['github'] });
      const runId = await makeRun(agentId, 'Sweep');
      local.push('Sweep.', choose('research.sweep', { question: 'perplexity' }), { done: true, summary: 'stop' });
      await worker().drain();
      const rows = await steps(runId);
      assert.equal(rows[1].status, 'failed');
      assert.match(rows[1].error, /denied: outside_read_scope/);
    });

    test('web search offline is denied by can(), and online it waits for approval at supervised', async () => {
      const agentId = await researcher();
      const offlineRun = await makeRun(agentId, 'Search the web');
      local.push('Search.', choose('research.web_search', { query: 'sparse attention' }), { done: true, summary: 'stop' });
      await worker({ online: () => false }).drain();
      assert.match((await steps(offlineRun))[1].error, /denied: offline/);

      const onlineRun = await makeRun(agentId, 'Search the web');
      local.push('Search.', choose('research.web_search', { query: 'sparse attention' }));
      await worker().drain();
      assert.equal((await runRow(onlineRun)).status, 'waiting_approval');
      const approvals = (await server.pool.query('SELECT capability FROM agent_approvals WHERE run_id = $1', [onlineRun])).rows;
      assert.deepEqual(approvals, [{ capability: 'research.web_search' }]);
    });
  });
});
