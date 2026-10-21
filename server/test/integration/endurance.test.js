import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import { tryEmbedDocument } from '../../src/lib/embeddings.js';
import { parseNdjson } from '../../src/lib/ollama.js';
import { upsertNodeByExternalId } from '../../src/models/nodeStore.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { createScopeArm } from '../../src/benchmark/endurance/arms.js';
import { DRY, SpendCap } from '../../src/benchmark/endurance/economics.js';
import { EXIT_UPSTREAM_ERROR, emitReport, runEndurance, withDryServices } from '../../src/benchmark/session.js';
import { FAKE_ANTHROPIC_KEY, startFakeAnthropic } from '../fakeAnthropic.js';
import { controlAccount, linkUser, startControlPlane } from '../fakeControl.js';
import { startFakeOllama } from '../fakeOllama.js';
import { ensureCentroids, registeredSession, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
// Obviously fake: it only ever reaches the stand-in Anthropic server below.
const PLATFORM = 'sk-ant-test-not-a-real-key';

// A small working day over a tiny corpus: a lookup, a follow-up that leans on
// it, a hard question, and a question that touches a private file.
const TURNS = [
  { ask: 'what does normalize_plate return', kind: 'lookup', mustMention: ['illumination'],
    mustCite: [{ project: 'acme/imaging', path: 'quantify.py' }] },
  { ask: 'and what does it divide the image by?', kind: 'followup', mustMention: ['illumination_field'],
    mustCite: [{ project: 'acme/imaging', path: 'quantify.py' }] },
  { ask: 'why was the plate normalised before counting colonies', kind: 'hard', mustMention: ['rim'],
    mustCite: [{ project: 'acme/imaging', path: 'NOTES.md' }] },
  { ask: 'what PWM frequency does the LED driver switch at', kind: 'lookup', mustMention: ['/25 ?kHz/'],
    mustCite: [{ project: 'acme/imaging', path: 'led_pwm.c' }] },
  { ask: 'where are the stepper calibration constants for the stage', kind: 'lookup', mustMention: ['calibration'],
    mustCite: [{ project: 'acme/stage', path: 'firmware/stage_motor.c' }] },
  { ask: 'compare the LED driver with the stepper calibration approach', kind: 'hard', mustMention: ['PWM'],
    mustCite: [{ project: 'acme/imaging', path: 'led_pwm.c' }] },
];

describe('endurance benchmark', () => {
  let server;
  let ollama;
  let anthropic;
  let control;
  let api;
  let ownerId;
  let email;

  async function readLines(response) {
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push(line);
    return lines;
  }

  const scenario = (overrides = {}) => ({
    id: 'code-tiny-day', plugin: 'code', plugins: ['github'], status: 'ready',
    fixture: { kind: 'corpus' }, plan: 'engineer', ownerEmail: email, turns: TURNS, ...overrides,
  });

  before(async () => {
    ollama = await startFakeOllama({ embedUrl: realOllama });
    anthropic = await startFakeAnthropic();
    process.env.OLLAMA_URL = ollama.url;
    process.env.ANTHROPIC_BASE_URL = anthropic.url;
    process.env.PLATFORM_ANTHROPIC_API_KEY = PLATFORM;
    server = await startServer();
    await ensureCentroids(server.pool);
    api = await registeredSession(server.base);
    ownerId = (await api('GET', '/api/auth/session')).data.userId;
    // Engineer on the real control plane, which answers the route's platform
    // turns through the same Anthropic stand-in the arm calls directly.
    control = await startControlPlane();
    process.env.CONTROL_URL = control.url;
    const account = await controlAccount(control, { email: 'endurance@scope.test', plan: 'engineer' });
    await linkUser(server.pool, ownerId, 'engineer', { token: account.token, fetchedAt: new Date(0) });
    email = (await server.pool.query('SELECT email FROM users WHERE id = $1', [ownerId])).rows[0].email;

    // Embedded when the real Ollama is up; otherwise retrieval is lexical-only,
    // which is just as real for what these tests check.
    const seed = async (repoId, project, path, content, privacy = 'cloud') => {
      const text = `${path}\n\n${content}`;
      return upsertNodeByExternalId({
        ownerId, type: 'file', source: 'github', project, privacy,
        externalId: `${repoId}|0|${path}`, content: text, embedding: await tryEmbedDocument(text),
      });
    };
    await seed(1, 'acme/imaging', 'quantify.py',
      'def normalize_plate(img):\n    """Return the plate image with illumination flattened."""\n    return img / illumination_field(img)');
    await seed(1, 'acme/imaging', 'illumination.py',
      'def illumination_field(img):\n    """Model the backlight gradient with a 151 px Gaussian blur."""\n    return cv2.GaussianBlur(img, (151, 151), 0)');
    await seed(1, 'acme/imaging', 'NOTES.md',
      'Decision: normalise every plate before counting colonies, because uneven illumination inflated counts at the rim.');
    await seed(1, 'acme/imaging', 'tests/test_quantify.py',
      'def test_normalize_plate():\n    assert normalize_plate(flat_plate()) is not None');
    await seed(1, 'acme/imaging', 'led_pwm.c',
      '/* PWM clock 25 MHz, range 1000: the LED driver switches at 25 kHz on GPIO 12. */\nint pwm_init(void) { return 1; }');
    await seed(2, 'acme/stage', 'firmware/stage_motor.c',
      '/* stepper calibration constants for the unreleased stage */\nconst int STEPS_PER_MM = 80;', 'local');
  });

  beforeEach(() => {
    resetConversations();
    resetWarmState();
    ollama.state.chatRequests = [];
    anthropic.state.requests = [];
    anthropic.state.authHeaders = [];
    Object.assign(anthropic.state, { failAfter: null, failStatus: 529, failModel: null });
  });

  after(async () => {
    process.env.OLLAMA_URL = realOllama;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CONTROL_URL;
    await control.close();
    delete process.env.PLATFORM_ANTHROPIC_API_KEY;
    await server.close();
    await ollama.close();
    await anthropic.close();
  });

  test('the Scope arm makes the same routing decisions and sends the same prompts as POST /api/chat', async () => {
    const arm = createScopeArm({ scenario: scenario(), ownerId, mode: 'dry', cap: new SpendCap(Infinity), platformKey: PLATFORM });
    const rows = [];
    for (const [i, turn] of TURNS.entries()) rows.push(await arm.turn(turn, i));
    const harness = { local: ollama.state.chatRequests, cloud: anthropic.state.requests };

    ollama.state.chatRequests = [];
    anthropic.state.requests = [];
    const conversationId = randomUUID();
    const contexts = [];
    for (const turn of TURNS) {
      const response = await api.raw('POST', '/api/chat', { query: turn.ask, conversationId });
      assert.equal(response.status, 200);
      contexts.push((await readLines(response))[0]);
    }
    const route = { local: ollama.state.chatRequests, cloud: anthropic.state.requests };
    // The route writes its metrics after the last token; wait for them, so the
    // next test's "nothing recorded" count starts from a settled table.
    for (let i = 0; i < 100; i++) {
      const { rows } = await server.pool.query('SELECT count(*)::int AS c FROM query_metrics WHERE owner_id = $1', [ownerId]);
      if (rows[0].c >= TURNS.length) break;
      await sleep(20);
    }

    for (const [i, context] of contexts.entries()) {
      const row = rows[i];
      const at = `turn ${i + 1}: ${TURNS[i].ask}`;
      assert.equal(row.decision, context.routing.decision, at);
      assert.equal(row.routeReason, context.routing.reason, at);
      assert.equal(row.tier, context.routing.tier, at);
      assert.equal(row.contextReused, context.routing.contextReused, at);
      assert.equal(row.difficulty, context.routing.difficulty, at);
      assert.equal(row.model, context.routing.model, at);
      assert.deepEqual(row.selected.map((node) => node.id), context.nodes.map((node) => node.id), at);
    }
    // The cases the parity has to cover all happened.
    assert.deepEqual(rows.map((row) => row.routeReason), ['context_size', 'context_size', 'complexity', 'context_size', 'privacy_flag', 'privacy_flag']);
    assert.equal(rows[1].contextReused, true, 'the follow-up continued the conversation');
    assert.equal(rows[2].model, 'anthropic/claude-opus-5', "Engineer's hard question goes to Opus");

    // Byte for byte, what each model was sent.
    assert.equal(harness.local.length, route.local.length);
    assert.deepEqual(harness.local, route.local);
    assert.equal(harness.cloud.length, 1);
    const sent = ({ model, system, messages, max_tokens, output_config }) => ({ model, system, messages, max_tokens, output_config });
    assert.deepEqual(harness.cloud.map(sent), route.cloud.map(sent));
  });

  test('a dry run plays every arm through every turn without recording anything, and lists pending scenarios', async () => {
    const metricsBefore = (await server.pool.query('SELECT count(*)::int AS c FROM query_metrics')).rows[0].c;
    const accessBefore = (await server.pool.query('SELECT sum(access_count)::int AS a FROM nodes')).rows[0].a;
    const pending = scenario({ id: 'kicad-board-day', plugin: 'kicad', plugins: ['kicad'], status: 'pending',
      fixture: { kind: 'reference', url: 'https://github.com/example/board', license: 'Apache-2.0' } });

    const report = await runEndurance({ scenarios: [scenario(), pending], mode: 'dry', triage: true });

    assert.equal(report.partial, false);
    assert.deepEqual(report.scenarios.map((s) => s.id), ['code-tiny-day'], 'the pending scenario is not run');
    assert.deepEqual(report.pending.map((p) => p.id), ['kicad-board-day']);
    assert.match(report.pending[0].reason, /kicad plug-in/);

    const [result] = report.scenarios;
    assert.deepEqual(Object.keys(result.arms), ['scope', 'baseline_sonnet', 'baseline_opus']);
    for (const [name, arm] of Object.entries(result.arms)) {
      assert.equal(arm.turnsRun, TURNS.length, name);
      assert.equal(arm.meanQuality, DRY);
      assert.equal(typeof arm.meanCiteCoverage, 'number');
      assert.equal(typeof arm.turnsUntilBudget, 'number');
      let previous = 0;
      for (const row of arm.turns) {
        for (const field of ['arm', 'model', 'routeReason', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'latencyMs', 'cumulativeCostUsd']) {
          assert.ok(field in row, `${name} turn ${row.turn} has ${field}`);
        }
        assert.equal(row.quality, DRY);
        assert.ok(row.cumulativeCostUsd >= previous);
        previous = row.cumulativeCostUsd;
      }
    }

    const sonnet = result.arms.baseline_sonnet.turns;
    assert.ok(sonnet.every((row) => row.costUsd > 0), 'every baseline turn goes to the cloud');
    assert.ok(sonnet.slice(1).every((row) => row.cacheReadTokens > 0), 'the transcript prefix is read from the cache');
    assert.ok(sonnet.at(-1).inputTokens + sonnet.at(-1).cacheReadTokens + sonnet.at(-1).cacheWriteTokens >
      sonnet[0].inputTokens + sonnet[0].cacheReadTokens + sonnet[0].cacheWriteTokens, 'the whole transcript is re-sent');
    assert.ok(result.arms.baseline_opus.totalCostUsd > result.arms.baseline_sonnet.totalCostUsd);
    assert.ok(result.arms.baseline_sonnet.turns.some((row) => row.privateNodesSent > 0), 'the cloud app sends the private file');

    const scope = result.arms.scope.turns;
    assert.ok(scope.filter((row) => row.decision === 'local').every((row) => row.costUsd === 0));
    // On a six-file corpus one Opus answer can outweigh six small Sonnet turns;
    // against the Opus baseline the order is never in doubt.
    assert.equal(result.arms.scope.cloudTurns, 1);
    assert.ok(result.arms.scope.totalCostUsd < result.arms.baseline_opus.totalCostUsd);
    assert.equal(result.budgetUsd > 0, true);
    for (const name of ['baseline_sonnet', 'baseline_opus']) {
      const comparison = result.comparisons[name];
      assert.equal(comparison.verdict, DRY);
      assert.equal(comparison.qualityRatio, DRY);
      assert.ok(['pass', 'fail'].includes(comparison.turnsGate));
      assert.equal(typeof comparison.turnsRatio, 'number');
    }
    assert.ok(result.comparisons.baseline_opus.turnsRatio > 1);
    assert.ok(Array.isArray(result.triage));
    assert.ok(report.plugins.code.costPerTurnUsd.scope < report.plugins.code.costPerTurnUsd.baseline_opus);

    const metricsAfter = (await server.pool.query('SELECT count(*)::int AS c FROM query_metrics')).rows[0].c;
    const accessAfter = (await server.pool.query('SELECT sum(access_count)::int AS a FROM nodes')).rows[0].a;
    assert.equal(metricsAfter, metricsBefore, 'no metrics rows');
    assert.equal(accessAfter, accessBefore, 'no access counts bumped');
    assert.ok(anthropic.state.authHeaders.length > 0);
    assert.ok(anthropic.state.authHeaders.every((key) => key === FAKE_ANTHROPIC_KEY), "a dry run sends only the stand-in's test key");
  });

  test('an upstream error partway stops only the arm it hit and keeps every turn already run', async () => {
    // Turn 1 answers both baselines; Sonnet's turn 2 is overloaded.
    Object.assign(anthropic.state, { failAfter: 2, failStatus: 529, failModel: 'claude-sonnet-5' });
    const report = await runEndurance({ scenarios: [scenario()], mode: 'dry' });

    assert.equal(report.partial, true);
    assert.equal(report.stopped, null, 'not the spend cap');
    assert.deepEqual(report.upstreamErrors.map(({ scenario: id, arm, turn, status }) => ({ id, arm, turn, status })),
      [{ id: 'code-tiny-day', arm: 'baseline_sonnet', turn: 2, status: 529 }]);
    const [result] = report.scenarios;
    assert.equal(result.arms.baseline_sonnet.turnsRun, 1, 'the turn before the error is kept');
    assert.ok(result.arms.baseline_sonnet.turns[0].costUsd > 0);
    assert.equal(result.arms.baseline_sonnet.stoppedBy.status, 529);
    assert.equal(result.arms.scope.turnsRun, TURNS.length, 'the other arms play on');
    assert.equal(result.arms.baseline_opus.turnsRun, TURNS.length);
    assert.equal(result.arms.scope.stoppedBy, undefined);

    // The partial report is written and printed, table and JSON both, and the
    // exit status says the run did not finish cleanly.
    const dir = mkdtempSync(join(tmpdir(), 'endurance-'));
    try {
      const printed = [];
      const code = emitReport(report, { out: true, resultsDir: dir, print: (text) => printed.push(text), note: () => {} });
      assert.equal(code, EXIT_UPSTREAM_ERROR);
      const [file] = readdirSync(dir);
      const written = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      assert.equal(written.scenarios[0].arms.baseline_sonnet.turns.length, 1);
      assert.equal(written.upstreamErrors[0].arm, 'baseline_sonnet');
      const stdout = printed.join('\n');
      assert.match(stdout, /PARTIAL: upstream error/);
      assert.match(stdout, /baseline_sonnet at turn 2: 529/);
      assert.deepEqual(JSON.parse(printed.at(-1)).upstreamErrors, written.upstreamErrors);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dropped connection stops the arm the same way, and a scenario with every arm stopped ends there', async () => {
    Object.assign(anthropic.state, { failAfter: 1, failStatus: 'network' });
    const report = await runEndurance({ scenarios: [scenario()], mode: 'dry', arms: ['baseline_opus'] });
    assert.equal(report.partial, true);
    assert.deepEqual(report.upstreamErrors.map(({ arm, turn, status }) => ({ arm, turn, status })),
      [{ arm: 'baseline_opus', turn: 2, status: null }]);
    assert.equal(report.scenarios[0].arms.baseline_opus.turnsRun, 1);
  });

  test('the spend cap stops every arm, leaves them level, and skips what is left', async () => {
    const report = await runEndurance({
      scenarios: [scenario(), scenario({ id: 'code-second-day' })], mode: 'dry', maxUsd: 0.01,
    });
    assert.equal(report.partial, true);
    assert.ok(report.spentUsd <= 0.01);
    assert.ok(['cap_reached', 'next_call_could_cross_cap'].includes(report.stopped.reason));
    const [first, second] = report.scenarios;
    const counts = Object.values(first.arms).map((arm) => arm.turnsRun);
    assert.ok(Math.max(...counts) < TURNS.length, 'the run stopped before the day ended');
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'arms stop within a turn of each other');
    assert.match(second.skipped, /spend cap/);
  });

  test('a scenario whose account is missing is skipped, not failed', async () => {
    const report = await runEndurance({ scenarios: [scenario({ ownerEmail: 'nobody@example.com' })], mode: 'dry' });
    assert.match(report.scenarios[0].skipped, /no account nobody@example.com/);
  });

  test('a dry run from the command line answers from stand-ins and puts the environment back', async () => {
    const before = { OLLAMA_URL: process.env.OLLAMA_URL, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL };
    await withDryServices(async ({ ollama: dryOllama, anthropic: dryAnthropic }) => {
      assert.equal(process.env.OLLAMA_URL, dryOllama.url);
      assert.equal(process.env.ANTHROPIC_BASE_URL, dryAnthropic.url);
      assert.ok(dryAnthropic.state.text.join('').length >= 900, 'answers are a fixed, realistic length');
    });
    assert.deepEqual({ OLLAMA_URL: process.env.OLLAMA_URL, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }, before);
  });
});
