import { describe, expect, it } from 'vitest';
import { applyRunEvent, budgetUsage, outputText, runViewFromHttp } from './runState.js';
import { workspaceEvent } from '../test/fakeEventSource.js';

const RUN = {
  id: 'run-1',
  agentId: 'agent-1',
  status: 'running',
  stepIndex: 0,
  tokensUsed: 100,
  costUsd: 0.01,
  budget: { maxTokens: 1000, maxUsd: 0.1, maxWallMs: 60_000 },
  startedAt: '2026-10-21T10:00:00.000Z',
  finishedAt: null,
  steps: [
    { id: 's1', index: 0, capability: 'read_graph', status: 'succeeded', output: { plan: ['a'] }, verification: [{ verifier: 'plan.nonempty', ok: true, detail: null }], nodeIds: ['n1'] },
  ],
};

const fold = (view, ...events) => events.reduce(applyRunEvent, view);

describe('runViewFromHttp', () => {
  it('normalises steps, approvals for this run, and written nodes', () => {
    const view = runViewFromHttp(RUN, [
      { id: 'p1', runId: 'run-1', stepId: 's1', capability: 'web', summary: 'search', status: 'pending' },
      { id: 'p2', runId: 'other', stepId: 'x', capability: 'web', status: 'pending' },
    ]);
    expect(view.steps[0]).toMatchObject({ id: 's1', capability: 'read_graph', verifications: [{ verifier: 'plan.nonempty', ok: true }] });
    expect(view.steps[0].output).toContain('"plan"');
    expect(Object.keys(view.approvals)).toEqual(['p1']);
    expect(view.written).toEqual([{ nodeId: 'n1', type: null, stepId: 's1' }]);
    expect(view.run.steps).toBeUndefined();
  });
});

describe('applyRunEvent', () => {
  it('streams a step from start to verified finish', () => {
    const view = fold(
      runViewFromHttp(RUN),
      workspaceEvent('step.started', { data: { stepId: 's2', index: 1, capability: 'web' } }),
      workspaceEvent('step.output', { data: { stepId: 's2', text: 'Found ' } }),
      workspaceEvent('step.output', { data: { stepId: 's2', text: 'three papers.' } }),
      workspaceEvent('step.verified', { data: { stepId: 's2', verifier: 'research.citations', ok: false, detail: 'one uncited claim' } }),
      workspaceEvent('step.finished', { data: { stepId: 's2', status: 'failed' } })
    );
    const step = view.steps.find((entry) => entry.id === 's2');
    expect(step).toMatchObject({ index: 1, capability: 'web', status: 'failed', output: 'Found three papers.' });
    expect(step.verifications).toEqual([{ verifier: 'research.citations', ok: false, detail: 'one uncited claim' }]);
    expect(view.run.stepIndex).toBe(1);
  });

  it('parks the current step on an approval and records the decision', () => {
    let view = fold(
      runViewFromHttp(RUN),
      workspaceEvent('step.started', { data: { stepId: 's2', index: 1, capability: 'edit_files' } }),
      workspaceEvent('approval.requested', { data: { approvalId: 'p9', capability: 'edit_files', summary: 'edit README' } })
    );
    expect(view.run.status).toBe('waiting_approval');
    expect(view.steps[1].status).toBe('waiting_approval');
    expect(view.approvals.p9).toMatchObject({ stepId: 's2', status: 'pending', summary: 'edit README' });
    view = applyRunEvent(view, workspaceEvent('approval.resolved', { data: { approvalId: 'p9', status: 'approved' } }));
    expect(view.approvals.p9.status).toBe('approved');
  });

  it('adds each cost event to the run totals', () => {
    const view = fold(runViewFromHttp(RUN), workspaceEvent('cost', { data: { tokens: 50, usd: 0.002, adapter: 'local' } }), workspaceEvent('cost', { data: { tokens: 25, usd: 0, adapter: 'local' } }));
    expect(view.run.tokensUsed).toBe(175);
    expect(view.run.costUsd).toBeCloseTo(0.012);
  });

  it('attaches written nodes to the running step and counts touches', () => {
    const view = fold(
      runViewFromHttp(RUN),
      workspaceEvent('step.started', { data: { stepId: 's2', index: 1, capability: 'write_notes' } }),
      workspaceEvent('node.written', { data: { nodeId: 'n7', type: 'finding' } }),
      workspaceEvent('node.touched', { data: { nodeIds: ['n1', 'n2'] } })
    );
    expect(view.written.at(-1)).toEqual({ nodeId: 'n7', type: 'finding', stepId: 's2' });
    expect(view.steps[1].nodeIds).toEqual(['n7']);
    expect(view.touched).toBe(2);
  });

  it('records the run outcome and budget limit', () => {
    const view = fold(
      runViewFromHttp(RUN),
      workspaceEvent('budget.exceeded', { data: { limit: 'maxUsd' } }),
      workspaceEvent('run.finished', { data: { status: 'budget_exceeded' } })
    );
    expect(view.budgetExceeded).toBe('maxUsd');
    expect(view.run.status).toBe('budget_exceeded');
    // A late lifecycle event never revives a finished run.
    expect(applyRunEvent(view, workspaceEvent('run.started')).run.status).toBe('budget_exceeded');
  });

  it('ignores another run’s events and returns the same object', () => {
    const view = runViewFromHttp(RUN);
    expect(applyRunEvent(view, workspaceEvent('step.started', { runId: 'run-2', data: { stepId: 'x', index: 0 } }))).toBe(view);
  });

  it('keeps output for a step it had not seen start', () => {
    const view = applyRunEvent(runViewFromHttp({ ...RUN, steps: [] }), workspaceEvent('step.output', { data: { stepId: 'late', text: 'hello' } }));
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({ id: 'late', output: 'hello' });
  });
});

describe('outputText', () => {
  it('prefers text, then summary, then JSON', () => {
    expect(outputText(null)).toBe('');
    expect(outputText('plain')).toBe('plain');
    expect(outputText({ text: 't' })).toBe('t');
    expect(outputText({ done: true, summary: 's' })).toBe('s');
    expect(outputText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('budgetUsage', () => {
  it('measures a live run’s clock from startedAt', () => {
    const usage = budgetUsage({ ...RUN, wallMs: 0 }, Date.parse('2026-10-21T10:00:30.000Z'));
    expect(usage.wall).toEqual({ used: 30_000, limit: 60_000, fraction: 0.5 });
    expect(usage.tokens.fraction).toBeCloseTo(0.1);
    expect(usage.usd.fraction).toBeCloseTo(0.1);
  });

  it('uses the stored wall time once the run has finished, and caps at 1', () => {
    const usage = budgetUsage({ ...RUN, status: 'budget_exceeded', finishedAt: '2026-10-21T10:02:00.000Z', wallMs: 120_000, tokensUsed: 5000 }, Date.now());
    expect(usage.wall.used).toBe(120_000);
    expect(usage.wall.fraction).toBe(1);
    expect(usage.tokens.fraction).toBe(1);
  });
});
