import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { weeklyAllowanceUsd } from '../../src/billing/plans.js';
import { withTranscriptBreakpoints } from '../../src/benchmark/endurance/arms.js';
import {
  DRY,
  LIVE_MAX_USD,
  SpendCap,
  priceRequest,
  qualityRatio,
  turnsRatio,
  turnsUntilBudget,
  verdict,
  worstCaseUsd,
} from '../../src/benchmark/endurance/economics.js';
import {
  MIN_TURNS,
  MAX_TURNS,
  citeCoverage,
  loadScenarios,
  mentionScore,
  validateScenario,
} from '../../src/benchmark/endurance/scenarios.js';
import { formatMarkdown, liveRefusal, parseArgs, runEndurance, suggestedCause, toJson } from '../../src/benchmark/session.js';

const turn = (overrides = {}) => ({
  ask: 'what does quantify_colonies return',
  kind: 'lookup',
  mustMention: ['count'],
  mustCite: [{ project: 'acme/imaging', path: 'quantify.py' }],
  ...overrides,
});
const scenario = (overrides = {}) => ({
  id: 'code-example',
  plugin: 'code',
  plugins: ['github'],
  status: 'ready',
  fixture: { kind: 'corpus' },
  plan: 'engineer',
  ownerEmail: 'someone@example.com',
  turns: Array.from({ length: MIN_TURNS }, () => turn()),
  ...overrides,
});

describe('the scenarios in the repository', () => {
  const loaded = loadScenarios();

  test('every file validates', () => {
    assert.deepEqual(loaded.errors, []);
  });

  test('ready code scenarios cover at least two repositories of the benchmark corpus', () => {
    const ready = loaded.ready.filter((s) => s.plugin === 'code');
    assert.ok(ready.length >= 2);
    const projects = new Set(ready.map((s) => s.project));
    assert.ok(projects.size >= 2, `only ${[...projects].join(', ')}`);
    for (const s of ready) {
      assert.equal(s.fixture.kind, 'corpus');
      assert.equal(s.ownerEmail, 'hynes-live@scope.local');
      assert.ok(s.turns.length >= MIN_TURNS && s.turns.length <= MAX_TURNS);
      assert.ok(s.turns.some((t) => t.kind === 'followup') && s.turns.some((t) => t.kind === 'hard'));
    }
  });

  test('the KiCad and research sessions wait as pending references to permissively licensed projects', () => {
    const byPlugin = Object.fromEntries(loaded.pending.map((s) => [s.plugin, s]));
    for (const plugin of ['kicad', 'research']) {
      const s = byPlugin[plugin];
      assert.ok(s, `no pending ${plugin} scenario`);
      assert.equal(s.fixture.kind, 'reference');
      assert.match(s.fixture.url, /^https:\/\/github\.com\//);
      assert.match(s.fixture.license, /^(Apache-2\.0|MIT|BSD|CC-BY-4\.0|CERN-OHL-P|0BSD)/);
    }
  });
});

describe('validateScenario', () => {
  test('a well-formed ready scenario has no problems', () => {
    assert.deepEqual(validateScenario(scenario()), []);
  });

  test('a working day is 30 to 50 turns', () => {
    assert.match(validateScenario(scenario({ turns: [turn()] })).join(), /30–50 turns/);
    assert.match(validateScenario(scenario({ turns: Array.from({ length: 51 }, () => turn()) })).join(), /30–50 turns/);
  });

  test('turn shape: kind, at least one mustMention term, valid patterns, cites with project and path', () => {
    const turns = [
      turn({ kind: 'chitchat' }),
      turn({ mustMention: [] }),
      turn({ mustMention: ['/unclosed(/'] }),
      turn({ mustCite: [{ project: 'acme/imaging' }] }),
      ...Array.from({ length: MIN_TURNS - 4 }, () => turn()),
    ];
    const problems = validateScenario(scenario({ turns })).join('\n');
    assert.match(problems, /turn 1: kind must be one of/);
    assert.match(problems, /turn 2: mustMention must list at least one term/);
    assert.match(problems, /turn 3: mustMention \/unclosed\(\/ is not a valid pattern/);
    assert.match(problems, /turn 4: every mustCite needs a project and a path/);
  });

  test('a ready scenario cannot run on a reference fixture, and a reference names its URL and license', () => {
    const problems = validateScenario(scenario({ fixture: { kind: 'reference' } })).join('\n');
    assert.match(problems, /needs a runnable fixture/);
    assert.match(problems, /https url/);
    assert.match(problems, /license/);
    const pending = scenario({ status: 'pending', fixture: { kind: 'reference', url: 'https://github.com/x/y', license: 'MIT' } });
    assert.deepEqual(validateScenario(pending), []);
  });

  test('a corpus needs its account, a plan must be platform-paid, and the plug-in must match its directory', () => {
    assert.match(validateScenario(scenario({ ownerEmail: undefined })).join(), /ownerEmail/);
    assert.match(validateScenario(scenario({ plan: 'key_pro' })).join(), /plan must be one of engineer, student/);
    assert.match(validateScenario(scenario(), { plugin: 'kicad' }).join(), /does not match its directory kicad/);
  });
});

describe('quality scoring', () => {
  test('mustMention terms are case-insensitive text or /regex/', () => {
    const { score, matched } = mentionScore('The COUNT is in summary_stats at 25 kHz', ['count', '/25 ?khz/', 'px_per_mm']);
    assert.equal(score, 2 / 3);
    assert.deepEqual(matched, ['count', '/25 ?khz/']);
  });

  test('citation coverage matches on project and path suffix, with * for a file kind', () => {
    const node = (project, path) => ({ project, external_id: `1|0|${path}` });
    const nodes = [node('acme/imaging', 'src/quantify.py'), node('acme/board', 'hw/main.kicad_sch')];
    assert.equal(citeCoverage(nodes, [{ project: 'acme/imaging', path: 'quantify.py' }]), 1);
    assert.equal(citeCoverage(nodes, [{ project: 'acme/imaging', path: 'antify.py' }]), 0);
    assert.equal(citeCoverage(nodes, [{ project: 'acme/board', path: '*sch' }, { project: 'acme/board', path: '*.kicad_pcb' }]), 0.5);
    assert.equal(citeCoverage(nodes, []), null);
  });
});

describe('equal-dollar turns', () => {
  test('a scenario that spends past the budget counts the turns inside it', () => {
    assert.deepEqual(turnsUntilBudget([0.5, 0.5, 0.5], 1), { turns: 2, projected: false, unbounded: false });
    assert.deepEqual(turnsUntilBudget([2, 0.1], 1), { turns: 0, projected: false, unbounded: false });
  });

  test('a scenario that ends first is projected from its mean cost per turn', () => {
    assert.deepEqual(turnsUntilBudget([0.1, 0.2], 3), { turns: 20, projected: true, unbounded: false });
    // Landing exactly on the budget is not past it.
    assert.deepEqual(turnsUntilBudget([0.5, 0.5], 1), { turns: 2, projected: true, unbounded: false });
  });

  test('a session that never reaches the cloud never runs out, and no turns means no answer', () => {
    assert.deepEqual(turnsUntilBudget([0, 0, 0], 1), { turns: Infinity, projected: true, unbounded: true });
    assert.deepEqual(turnsUntilBudget([], 1), { turns: null, projected: false, unbounded: false });
  });

  test('the budget is the plan weekly allowance', () => {
    assert.ok(weeklyAllowanceUsd('engineer') > weeklyAllowanceUsd('student'));
    assert.ok(weeklyAllowanceUsd('student') > 0);
  });

  test('ratios handle an unbounded side and an arm that could not afford one turn', () => {
    assert.equal(turnsRatio(30, 10), 3);
    assert.equal(turnsRatio(Infinity, 10), Infinity);
    assert.equal(turnsRatio(5, 0), Infinity);
    assert.equal(turnsRatio(Infinity, Infinity), null);
    assert.equal(turnsRatio(null, 10), null);
  });

  test('quality is compared on the turns both arms answered', () => {
    assert.equal(qualityRatio([1, 0.5, 1], [1, 1]), 0.75);
    assert.equal(qualityRatio([0, 0], [0, 0]), 1);
    assert.equal(qualityRatio([], [1]), null);
  });
});

describe('verdict', () => {
  test('exactly 3x the turns at exactly 90% of the quality passes', () => {
    assert.equal(verdict({ turnsRatio: 3, qualityRatio: 0.9 }).verdict, 'pass');
    // 0.27 / 0.3 is 0.9000000000000001 in floating point and 0.72 / 0.8 is
    // 0.8999999999999999: both are exactly 90%, and both must pass.
    assert.ok(qualityRatio([0.72], [0.8]) < 0.9);
    assert.equal(verdict({ turnsRatio: 30 / 10, qualityRatio: qualityRatio([0.27], [0.3]) }).verdict, 'pass');
    assert.equal(verdict({ turnsRatio: 3, qualityRatio: qualityRatio([0.72], [0.8]) }).verdict, 'pass');
  });

  test('just under either gate fails, and says which', () => {
    assert.deepEqual(verdict({ turnsRatio: 2.99, qualityRatio: 1 }), { verdict: 'fail', turnsGate: 'fail', qualityGate: 'pass' });
    assert.deepEqual(verdict({ turnsRatio: 10, qualityRatio: 0.899 }), { verdict: 'fail', turnsGate: 'pass', qualityGate: 'fail' });
    assert.equal(verdict({ turnsRatio: Infinity, qualityRatio: 0.95 }).verdict, 'pass');
  });

  test('a dry run reports the turns gate but never a pass', () => {
    assert.deepEqual(verdict({ turnsRatio: 5, qualityRatio: null, dry: true }), { verdict: DRY, turnsGate: 'pass', qualityGate: DRY });
    assert.equal(verdict({ turnsRatio: null, qualityRatio: 1 }).verdict, 'incomplete');
  });
});

describe('the spend cap', () => {
  test('a call whose worst case would cross $5 is refused before it is sent', () => {
    const cap = new SpendCap(LIVE_MAX_USD);
    assert.equal(cap.allows(4), true);
    cap.settle(4);
    assert.equal(cap.allows(1.5), false);
    assert.equal(cap.stopped.reason, 'next_call_could_cross_cap');
    assert.equal(cap.allows(0.01), false, 'once stopped, every arm stays stopped');
    assert.equal(cap.spentUsd, 4);
  });

  test('reaching the cap stops the run', () => {
    const cap = new SpendCap(LIVE_MAX_USD);
    cap.settle(2.5);
    assert.equal(cap.stopped, null);
    cap.settle(2.5);
    assert.equal(cap.stopped.reason, 'cap_reached');
    assert.equal(cap.allows(0), false);
  });

  test('the worst case assumes cache writes and a full-length answer', () => {
    const usd = worstCaseUsd('claude-opus-5', 10_000, 2048);
    assert.ok(usd > (10_000 * 5 + 2048 * 25) / 1_000_000);
    assert.equal(worstCaseUsd('not-a-model', 1, 1), Infinity);
  });
});

describe('cache pricing for dry runs', () => {
  const system = 'S'.repeat(400);
  const first = 'U'.repeat(4000);
  const answer = 'A'.repeat(1000);
  const second = 'V'.repeat(2000);

  test('the first request writes its prefix; the next reads it and writes only what is new', () => {
    const cache = new Set();
    const one = priceRequest({ model: 'claude-sonnet-5', system, messages: withTranscriptBreakpoints([{ role: 'user', content: first }]), outputTokens: 100, cache });
    assert.deepEqual(one.usage, { input_tokens: 0, cache_creation_input_tokens: 1100, cache_read_input_tokens: 0, output_tokens: 100 });

    const messages = withTranscriptBreakpoints([
      { role: 'user', content: first },
      { role: 'assistant', content: answer },
      { role: 'user', content: second },
    ]);
    const two = priceRequest({ model: 'claude-sonnet-5', system, messages, outputTokens: 100, cache });
    assert.deepEqual(two.usage, { input_tokens: 0, cache_creation_input_tokens: 750, cache_read_input_tokens: 1100, output_tokens: 100 });
    assert.ok(two.costUsd < one.costUsd + 0.002, 're-reading the transcript is cheap');

    const opus = priceRequest({ model: 'claude-opus-5', system, messages, outputTokens: 100, cache });
    assert.equal(opus.usage.cache_read_input_tokens, 0, 'caches are per model');
  });

  test('only the last two user turns carry breakpoints', () => {
    const marked = withTranscriptBreakpoints([
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ]);
    assert.equal(typeof marked[0].content, 'string');
    assert.equal(marked[2].content[0].cache_control.type, 'ephemeral');
    assert.equal(marked[4].content[0].cache_control.type, 'ephemeral');
    assert.equal(typeof marked[3].content, 'string');
  });
});

describe('live mode', () => {
  test('refuses without PLATFORM_ANTHROPIC_API_KEY, and there is no default', () => {
    assert.match(liveRefusal({}), /PLATFORM_ANTHROPIC_API_KEY/);
    assert.match(liveRefusal({ PLATFORM_ANTHROPIC_API_KEY: '' }), /Refusing/);
    assert.equal(liveRefusal({ PLATFORM_ANTHROPIC_API_KEY: 'present' }), null);
  });

  test('the runner refuses a live run with no key before touching anything', async () => {
    const resolveOwner = () => assert.fail('nothing is read before the refusal');
    await assert.rejects(runEndurance({ scenarios: [scenario()], mode: 'live', resolveOwner }), /PLATFORM_ANTHROPIC_API_KEY/);
  });

  test('--max-usd may lower the $5 cap and never raise it', async () => {
    assert.equal(parseArgs(['--live']).mode, 'live');
    assert.equal(parseArgs(['--live', '--max-usd', '2']).maxUsd, 2);
    assert.throws(() => parseArgs(['--live', '--max-usd', '6']), /at most 5/);
    assert.throws(() => parseArgs(['--max-usd=0']), /above 0/);
    await assert.rejects(runEndurance({ scenarios: [], mode: 'dry', maxUsd: 5.01 }), /at most 5/);
  });

  test('flags are checked: one mode, known arms', () => {
    assert.equal(parseArgs([]).mode, 'dry');
    assert.throws(() => parseArgs(['--dry', '--live']), /one of --dry or --live/);
    assert.throws(() => parseArgs(['--arms', 'scope,baseline_haiku']), /unknown arm: baseline_haiku/);
    assert.deepEqual(parseArgs(['--scenario', 'a,b', '--triage']).scenarios, ['a', 'b']);
  });
});

describe('reporting', () => {
  test('an unbounded ratio survives JSON as a word', () => {
    assert.match(toJson({ ratio: Infinity, plain: 2 }), /"ratio": "unbounded"/);
  });

  test('the markdown lists pending scenarios and marks a partial run', () => {
    const text = formatMarkdown({
      mode: 'live', spentUsd: 5, maxUsd: 5, partial: true, scenarios: [], plugins: {},
      pending: [{ id: 'kicad-x', plugin: 'kicad', turns: 30, reason: 'waiting on the kicad plug-in' }],
    });
    assert.match(text, /PARTIAL: spend cap reached/);
    assert.match(text, /kicad-x \(kicad, 30 turns\): waiting on the kicad plug-in/);
  });

  test('loss triage guesses the cause from what the turn read and where it went', () => {
    assert.equal(suggestedCause({ citeCoverage: 0.5, decision: 'cloud' }, { kind: 'lookup' }), 'retrieval_miss');
    assert.equal(suggestedCause({ citeCoverage: 1, decision: 'local', difficulty: null }, { kind: 'hard' }), 'routing_should_have_escalated');
    assert.equal(suggestedCause({ citeCoverage: 1, decision: 'local', difficulty: null }, { kind: 'lookup' }), 'local_model_weakness');
    assert.equal(suggestedCause({ citeCoverage: null, decision: 'cloud' }, { kind: 'hard' }), 'cloud_answer_gap');
  });
});
