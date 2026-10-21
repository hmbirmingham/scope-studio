import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AGENT_COLORS,
  DEFAULT_BUDGET,
  isUuid,
  validateBudget,
  validateColor,
  validateLevel,
  validateModelPolicy,
  validateName,
  validateOverrides,
  validateRoleFields,
  validateScopes,
  validateTask,
} from '../../src/workspace/agents/validation.js';
import { presentAgent, presentApproval, presentTask } from '../../src/workspace/agents/presenters.js';
import { computeNextRun } from '../../src/workspace/agents/taskStore.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

describe('agent validation', () => {
  test('names are trimmed and limited to 80 characters', () => {
    assert.equal(validateName('  Ada  ').value, 'Ada');
    assert.equal(validateName('x'.repeat(80)).value.length, 80);
    for (const bad of ['', '   ', 'x'.repeat(81), 5, null, undefined]) assert.equal(validateName(bad).error, 'invalid_name');
  });

  test('levels must be one of the four', () => {
    assert.equal(validateLevel('agentic').value, 'agentic');
    for (const bad of ['root', '', null, 1]) assert.equal(validateLevel(bad).error, 'invalid_level');
  });

  test('overrides accept known capabilities with allow, ask or deny', () => {
    assert.deepEqual(validateOverrides({ web: 'deny', edit_files: 'allow' }).value, { web: 'deny', edit_files: 'allow' });
    assert.deepEqual(validateOverrides({}).value, {});
    for (const bad of [{ shell: 'allow' }, { web: 'yes' }, { web: null }, [], 'x', null]) {
      assert.equal(validateOverrides(bad).error, 'invalid_overrides', JSON.stringify(bad));
    }
  });

  test('scopes are arrays of non-empty strings, and what is left out is empty', () => {
    assert.deepEqual(validateScopes({ read: { projects: ['a', 'a'], sources: ['*'] }, write: { projects: ['a'] } }).value, {
      read: { projects: ['a'], sources: ['*'] },
      write: { projects: ['a'] },
    });
    assert.deepEqual(validateScopes({}).value, { read: { projects: [], sources: [] }, write: { projects: [] } });
    for (const bad of [
      { read: { projects: 'a' } },
      { read: { projects: [''] } },
      { write: { projects: [1] } },
      { read: [] },
      { write: { projects: [null] } },
      'all',
      null,
    ]) {
      assert.equal(validateScopes(bad).error, 'invalid_scopes', JSON.stringify(bad));
    }
  });

  test('model policy: own_key needs the key_pro plan', () => {
    assert.equal(validateModelPolicy('local_only', 'free').value, 'local_only');
    assert.equal(validateModelPolicy('local_cloud', 'free').value, 'local_cloud');
    assert.equal(validateModelPolicy('own_key', 'key_pro').value, 'own_key');
    for (const plan of ['free', 'pro', undefined]) assert.equal(validateModelPolicy('own_key', plan).error, 'own_key_requires_key_pro');
    assert.equal(validateModelPolicy('cloud_only', 'key_pro').error, 'invalid_model_policy');
  });

  test('budget values are positive finite numbers merged over the base', () => {
    assert.deepEqual(validateBudget({ maxUsd: 2 }).value, { ...DEFAULT_BUDGET, maxUsd: 2 });
    for (const bad of [{ maxUsd: 0 }, { maxTokens: -1 }, { maxWallMs: Infinity }, { maxUsd: NaN }, { maxUsd: '1' }, { maxTokens: null }, { other: 1 }, [], null]) {
      assert.equal(validateBudget(bad).error, 'invalid_budget', JSON.stringify(bad));
    }
  });

  test('colours are #rrggbb', () => {
    assert.equal(validateColor('#AABBCC').value, '#aabbcc');
    for (const bad of ['red', '#abc', '#abcdefg', 'aabbcc', 5]) assert.equal(validateColor(bad).error, 'invalid_color');
    assert.ok(AGENT_COLORS.every((c) => validateColor(c).value === c));
  });

  test('role fields are length-capped', () => {
    assert.equal(validateRoleFields({ title: 'T', tags: ['a', 'a'] }).value.tags.length, 1);
    assert.equal(validateRoleFields({ description: 'x' }, { partial: true }).value.description, 'x');
    for (const bad of [
      {},
      { title: '' },
      { title: 'x'.repeat(121) },
      { title: 'T', description: 'x'.repeat(2001) },
      { title: 'T', embodiment: 'x'.repeat(8001) },
      { title: 'T', tags: 'a' },
      { title: 'T', tags: [''] },
      { title: 'T', tags: Array(21).fill('a') },
      null,
    ]) {
      assert.equal(validateRoleFields(bad).error, 'invalid_role', JSON.stringify(bad));
    }
  });
});

describe('task validation', () => {
  const good = { agentId: AGENT_ID, title: 'Nightly', instructions: 'Do it' };

  test('accepts a minimal and a scheduled task', () => {
    assert.equal(validateTask(good).value.title, 'Nightly');
    assert.equal(validateTask({ ...good, schedule: '*/15 * * * *', project: 'p', enabled: false }).value.schedule, '*/15 * * * *');
    assert.equal(validateTask({ schedule: null }, { partial: true }).value.schedule, null);
  });

  test('rejects bad schedules with the cron message', () => {
    for (const schedule of ['nope', '* * * *', '61 * * * *', '0 0 31 2 *', 5]) {
      const result = validateTask({ ...good, schedule });
      assert.equal(result.error, 'invalid_schedule', String(schedule));
      assert.ok(result.message);
    }
  });

  test('rejects other bad fields', () => {
    assert.equal(validateTask({ ...good, title: '' }).error, 'invalid_title');
    assert.equal(validateTask({ ...good, instructions: '  ' }).error, 'invalid_instructions');
    assert.equal(validateTask({ ...good, project: '' }).error, 'invalid_project');
    assert.equal(validateTask({ ...good, enabled: 'yes' }).error, 'invalid_enabled');
    assert.equal(validateTask({ ...good, agentId: 'nope' }).error, 'invalid_agent');
    assert.equal(validateTask(null).error, 'invalid_body');
  });

  test('next run exists only for a scheduled, enabled task', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    assert.equal(computeNextRun({ schedule: '30 * * * *', enabled: true }, now).toISOString(), '2026-01-01T00:30:00.000Z');
    assert.equal(computeNextRun({ schedule: '30 * * * *', enabled: false }, now), null);
    assert.equal(computeNextRun({ schedule: null, enabled: true }, now), null);
  });
});

describe('presenters and ids', () => {
  test('uuid check', () => {
    assert.equal(isUuid(AGENT_ID), true);
    for (const bad of ['x', '', null, undefined, 5, AGENT_ID + 'a']) assert.equal(isUuid(bad), false);
  });

  test('camelCase shapes from the contract', () => {
    const at = new Date('2026-01-02T03:04:05Z');
    const agent = presentAgent({
      id: AGENT_ID, name: 'A', role: { title: 'T' }, level: 'manual', overrides: {}, scopes: {}, model_policy: 'local_only',
      budget: {}, state: 'active', color: '#000000', created_at: at, updated_at: at,
    });
    assert.deepEqual(Object.keys(agent), ['id', 'name', 'role', 'level', 'overrides', 'scopes', 'modelPolicy', 'budget', 'state', 'color', 'createdAt', 'updatedAt']);
    assert.deepEqual(Object.keys(agent.role), ['template', 'title', 'description', 'embodiment', 'tags']);
    assert.equal(agent.createdAt, '2026-01-02T03:04:05.000Z');
    assert.deepEqual(Object.keys(presentTask({ created_at: at, updated_at: at })), ['id', 'agentId', 'title', 'instructions', 'project', 'schedule', 'nextRunAt', 'enabled', 'createdAt', 'updatedAt']);
    assert.deepEqual(Object.keys(presentApproval({ created_at: at })), ['id', 'agentId', 'runId', 'stepId', 'capability', 'summary', 'detail', 'status', 'createdAt', 'resolvedAt']);
  });
});
