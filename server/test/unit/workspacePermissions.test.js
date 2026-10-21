import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CAPABILITIES, DECISIONS, LEVELS, can, decide, inReadScope } from '../../src/workspace/permissions.js';

// A fully scoped, active agent so the level table is the only thing in play.
const agent = (over = {}) => ({
  state: 'active',
  level: 'supervised',
  overrides: {},
  modelPolicy: 'local_cloud',
  scopes: { read: { projects: ['*'], sources: ['*'] }, write: { projects: ['*'] } },
  ...over,
});
// An ordinary online step: the network flags fail closed, so say so explicitly.
const ctx = (over = {}) => ({ project: 'p', online: true, privateContext: false, ...over });

// The doc's "Default decision by level" table. 'sandbox' means allow in the
// sandbox and ask outside it; 'sandbox-only' means allow in, deny outside (the
// hard denial for model-written code); 'ask-sandbox-only' asks in, denies outside.
const TABLE = {
  read_graph: { manual: 'ask', supervised: 'allow', sandboxed: 'allow', agentic: 'allow' },
  write_notes: { manual: 'ask', supervised: 'allow', sandboxed: 'allow', agentic: 'allow' },
  edit_files: { manual: 'ask', supervised: 'ask', sandboxed: 'sandbox', agentic: 'allow' },
  run_scripts: { manual: 'ask', supervised: 'ask', sandboxed: 'sandbox', agentic: 'allow' },
  run_generated_code: { manual: 'ask-sandbox-only', supervised: 'ask-sandbox-only', sandboxed: 'sandbox-only', agentic: 'sandbox-only' },
  web: { manual: 'ask', supervised: 'ask', sandboxed: 'ask', agentic: 'allow' },
  cloud_model: { manual: 'ask', supervised: 'ask', sandboxed: 'ask', agentic: 'allow' },
  open_pr: { manual: 'ask', supervised: 'ask', sandboxed: 'ask', agentic: 'allow' },
  apply_merge: { manual: 'ask', supervised: 'ask', sandboxed: 'ask', agentic: 'allow' },
};

function expected(cell, inSandbox) {
  if (cell === 'sandbox') return inSandbox ? 'allow' : 'ask';
  if (cell === 'sandbox-only') return inSandbox ? 'allow' : 'deny';
  if (cell === 'ask-sandbox-only') return inSandbox ? 'ask' : 'deny';
  return cell;
}

describe('permissions: the default table', () => {
  test('the table covers every level and capability', () => {
    assert.deepEqual(Object.keys(TABLE).sort(), [...CAPABILITIES].sort());
    for (const row of Object.values(TABLE)) assert.deepEqual(Object.keys(row).sort(), [...LEVELS].sort());
  });

  for (const level of LEVELS) {
    for (const capability of CAPABILITIES) {
      for (const inSandbox of [true, false]) {
        test(`${level} / ${capability} / inSandbox=${inSandbox}`, () => {
          const result = decide(agent({ level }), capability, ctx({ inSandbox }));
          assert.equal(result.decision, expected(TABLE[capability][level], inSandbox));
          assert.equal(can(agent({ level }), capability, ctx({ inSandbox })), result.decision);
        });
      }
    }
  }

  test('an unknown level is treated as the most cautious one', () => {
    assert.equal(can(agent({ level: 'wide_open' }), 'edit_files', ctx()), 'ask');
  });

  test('a missing level falls back to the default level', () => {
    assert.equal(can(agent({ level: undefined }), 'edit_files', ctx()), 'ask');
    assert.equal(can(agent({ level: undefined }), 'read_graph', ctx()), 'allow');
  });
});

describe('permissions: hard denials hold at every level, with and without an allow override', () => {
  const allowEverything = Object.fromEntries(CAPABILITIES.map((c) => [c, 'allow']));
  const withAndWithout = [{}, allowEverything];

  for (const level of LEVELS) {
    for (const overrides of withAndWithout) {
      const label = `${level}${Object.keys(overrides).length ? ' + allow overrides' : ''}`;

      test(`${label}: a killed or paused agent can do nothing`, () => {
        for (const state of ['killed', 'paused', 'archived', undefined]) {
          for (const capability of CAPABILITIES) {
            assert.equal(can(agent({ level, overrides, state }), capability, ctx({ inSandbox: true })), 'deny', `${state} ${capability}`);
          }
        }
        assert.equal(decide(agent({ level, overrides, state: 'killed' }), 'read_graph', ctx()).reason, 'agent_killed');
        assert.equal(decide(agent({ level, overrides, state: 'paused' }), 'read_graph', ctx()).reason, 'agent_paused');
        assert.equal(decide(agent({ level, overrides, state: 'weird' }), 'read_graph', ctx()).reason, 'agent_inactive');
      });

      test(`${label}: no agent and unknown capabilities are denied`, () => {
        assert.equal(decide(null, 'read_graph', ctx()).decision, 'deny');
        assert.equal(decide(agent({ level, overrides }), 'format_disk', ctx()).reason, 'unknown_capability');
      });

      test(`${label}: model-written code never runs outside the sandbox`, () => {
        for (const inSandbox of [false, undefined, 'true', 1]) {
          const result = decide(agent({ level, overrides }), 'run_generated_code', ctx({ inSandbox }));
          assert.deepEqual(result, { decision: 'deny', reason: 'outside_sandbox' });
        }
      });

      test(`${label}: reads outside the read scope are denied`, () => {
        const narrow = { read: { projects: ['other'], sources: ['github'] }, write: { projects: ['*'] } };
        assert.equal(decide(agent({ level, overrides, scopes: narrow }), 'read_graph', ctx({ source: 'github' })).reason, 'outside_read_scope');
        // Right project, wrong source.
        assert.equal(can(agent({ level, overrides, scopes: { ...narrow, read: { projects: ['p'], sources: ['github'] } } }), 'read_graph', ctx({ source: 'kicad' })), 'deny');
      });

      test(`${label}: writes outside the write scope are denied`, () => {
        const readOnly = { read: { projects: ['*'], sources: ['*'] }, write: { projects: ['other'] } };
        for (const capability of ['write_notes', 'edit_files', 'run_scripts', 'open_pr', 'apply_merge']) {
          const result = decide(agent({ level, overrides, scopes: readOnly }), capability, ctx({ inSandbox: true }));
          assert.deepEqual(result, { decision: 'deny', reason: 'outside_write_scope' }, capability);
        }
      });

      test(`${label}: web and cloud need the caller to say it is online`, () => {
        for (const online of [false, undefined, 'true']) {
          assert.equal(decide(agent({ level, overrides }), 'web', ctx({ online })).reason, 'offline');
          assert.equal(decide(agent({ level, overrides }), 'cloud_model', ctx({ online })).reason, 'offline');
        }
      });

      test(`${label}: the cloud is refused for a local-only policy`, () => {
        for (const modelPolicy of ['local_only', undefined]) {
          assert.equal(decide(agent({ level, overrides, modelPolicy }), 'cloud_model', ctx()).reason, 'local_only_policy');
        }
      });

      test(`${label}: the cloud is refused when private nodes are in the context`, () => {
        for (const privateContext of [true, undefined, 'false']) {
          assert.equal(decide(agent({ level, overrides }), 'cloud_model', ctx({ privateContext })).reason, 'private_context');
        }
      });
    }
  }
});

describe('permissions: overrides', () => {
  test('an override replaces the level default in either direction', () => {
    assert.equal(can(agent({ level: 'manual', overrides: { read_graph: 'allow' } }), 'read_graph', ctx()), 'allow');
    assert.equal(can(agent({ level: 'agentic', overrides: { edit_files: 'ask' } }), 'edit_files', ctx()), 'ask');
    assert.equal(can(agent({ level: 'agentic', overrides: { web: 'deny' } }), 'web', ctx()), 'deny');
    assert.equal(decide(agent({ overrides: { web: 'allow' } }), 'web', ctx()).reason, 'override');
  });

  test('an override only applies to its own capability', () => {
    assert.equal(can(agent({ overrides: { web: 'allow' } }), 'open_pr', ctx()), 'ask');
  });

  test('an invalid override value is ignored, not trusted', () => {
    for (const bad of ['yes', 'ALLOW', true, null, 1]) {
      assert.equal(can(agent({ level: 'manual', overrides: { edit_files: bad } }), 'edit_files', ctx()), 'ask');
    }
    assert.ok(DECISIONS.every((d) => ['allow', 'ask', 'deny'].includes(d)));
  });
});

describe('permissions: scopes', () => {
  const scoped = (read, write = ['*']) => agent({ scopes: { read, write: { projects: write } } });

  test("'*' covers every project and source", () => {
    const a = scoped({ projects: ['*'], sources: ['*'] });
    assert.equal(can(a, 'read_graph', { project: 'anything', source: 'kicad' }), 'allow');
    assert.equal(can(a, 'read_graph', {}), 'allow');
  });

  test('explicit lists allow only what they name', () => {
    const a = scoped({ projects: ['alpha', 'beta'], sources: ['github'] });
    assert.equal(can(a, 'read_graph', { project: 'beta', source: 'github' }), 'allow');
    assert.equal(can(a, 'read_graph', { project: 'gamma', source: 'github' }), 'deny');
    assert.equal(can(a, 'read_graph', { project: 'alpha', source: 'kicad' }), 'deny');
  });

  test('a read that names no source needs every source to be readable', () => {
    assert.equal(can(scoped({ projects: ['alpha'], sources: ['github'] }), 'read_graph', { project: 'alpha' }), 'deny');
    assert.equal(can(scoped({ projects: ['alpha'], sources: ['*'] }), 'read_graph', { project: 'alpha' }), 'allow');
  });

  test('a read or write that names no project is denied unless the scope is wildcard', () => {
    assert.equal(can(scoped({ projects: ['alpha'], sources: ['*'] }), 'read_graph', {}), 'deny');
    assert.equal(can(scoped({ projects: ['*'], sources: ['*'] }, ['alpha']), 'write_notes', {}), 'deny');
    assert.equal(can(scoped({ projects: ['*'], sources: ['*'] }, ['*']), 'write_notes', {}), 'allow');
  });

  test('empty or malformed scopes deny everything', () => {
    for (const scopes of [undefined, {}, { read: {}, write: {} }, { read: { projects: 'p', sources: 'x' }, write: { projects: 'p' } }]) {
      const a = agent({ scopes });
      assert.equal(can(a, 'read_graph', ctx({ source: 'github' })), 'deny');
      assert.equal(can(a, 'write_notes', ctx()), 'deny');
    }
  });

  test('inReadScope agrees with the read_graph decision', () => {
    const a = scoped({ projects: ['alpha'], sources: ['github'] });
    assert.equal(inReadScope(a, { project: 'alpha', source: 'github' }), true);
    assert.equal(inReadScope(a, { project: 'alpha', source: 'kicad' }), false);
    assert.equal(inReadScope(a, { project: 'beta', source: 'github' }), false);
    assert.equal(inReadScope(a), false);
  });
});

describe('permissions: offline and private context', () => {
  test('offline, only the local capabilities remain', () => {
    const a = agent({ level: 'agentic' });
    const offline = ctx({ online: false, inSandbox: true });
    assert.equal(can(a, 'web', offline), 'deny');
    assert.equal(can(a, 'cloud_model', offline), 'deny');
    for (const capability of CAPABILITIES.filter((c) => c !== 'web' && c !== 'cloud_model')) {
      assert.equal(can(a, capability, offline), 'allow', capability);
    }
  });

  test('a private context blocks only the cloud', () => {
    const a = agent({ level: 'agentic' });
    assert.equal(can(a, 'cloud_model', ctx({ privateContext: true })), 'deny');
    assert.equal(can(a, 'web', ctx({ privateContext: true })), 'allow');
    assert.equal(can(a, 'cloud_model', ctx({ privateContext: false })), 'allow');
  });

  test('an own_key policy permits the cloud like local_cloud does', () => {
    assert.equal(can(agent({ level: 'agentic', modelPolicy: 'own_key' }), 'cloud_model', ctx()), 'allow');
  });
});
