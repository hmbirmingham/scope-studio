import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { nextRunAt } from '../../src/workspace/cron.js';
import { createScheduler, createWorker, defaultAdapters } from '../../src/workspace/runner/index.js';
import { sandboxStatus } from '../../src/workspace/sandbox/index.js';
import { meFor, newDeviceToken, startFakeControl } from '../fakeControl.js';
import { deadUrl, startFakeOllama } from '../fakeOllama.js';
import { registeredSession, startServer } from '../helpers.js';

// The whole agent workspace, end to end, with every outside service faked:
// a person signs in through the control link, makes an agent and a weekly
// task over HTTP, the scheduler fires the task when its slot comes, the
// worker runs it on the local model (the Ollama stand-in) until a step asks
// for approval, the person approves it over HTTP, the run finishes, and the
// artifact it wrote is in the graph with the privacy of what it was made
// from. The activity stream is read over HTTP the whole time, as the
// workspace UI reads it, and its events must arrive in the order the
// protocol fixes. Every link is asserted where it happens, so a break
// anywhere in the chain fails the test at that link.

const sandbox = await sandboxStatus();
const skip = sandbox.available ? false : `no OS sandbox on this machine (${sandbox.reason})`;
if (skip) console.log(`# skipping the workspace end-to-end test: ${skip}`);

const PROJECT = 'phys-lab';
const SCHEDULE = '30 9 * * 1'; // Mondays at 09:30 UTC.
const INSTRUCTIONS = 'Fit g from the pendulum lab data and save the result for the lab report.';
const LAB_NOTE = [
  'Pendulum lab data (private draft, do not share).',
  'Lengths in metres: 0.20 0.40 0.60 0.80 1.00.',
  'Mean periods in seconds: 0.897 1.269 1.554 1.794 2.006.',
  'Fit g from T squared against L for the lab report.',
].join('\n');
// The code the agent writes: a least-squares fit of T² against L through
// the origin, g = 4π² / slope. It runs in the OS sandbox, and what it prints
// reaches the next step only through the graph.
const FIT_CODE = [
  'const L = [0.2, 0.4, 0.6, 0.8, 1.0];',
  'const T = [0.897, 1.269, 1.554, 1.794, 2.006];',
  'const slope = L.reduce((s, l, i) => s + l * T[i] ** 2, 0) / L.reduce((s, l) => s + l * l, 0);',
  'console.log(`g = ${(4 * Math.PI ** 2 / slope).toFixed(3)} m/s^2`);',
].join('\n');
const PLAN = '1. Fit g from the data with a short script in the sandbox.\n2. Save the result as an artifact.\n3. Finish.';

// Reads the stream the way the UI does and keeps every event with its SSE
// framing, so the test can check the id and event lines as well as the data.
function readEvents(response) {
  const events = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = {};
        for (const line of block.split('\n')) {
          const colon = line.indexOf(':');
          if (colon <= 0) continue;
          fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
        }
        if (fields.data) events.push({ id: fields.id, event: fields.event, data: JSON.parse(fields.data) });
      }
    }
  })().catch(() => {});
  return { events, reading };
}

describe('the agent workspace end to end', { skip }, () => {
  let server;
  let control;
  let ollama;
  let api;
  let worker;
  let stream;
  let streamAbort;
  const ctx = {};

  async function waitFor(condition, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await condition();
      if (value) return value;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  const runEvents = () => stream.events.map((entry) => entry.data).filter((event) => event.runId === ctx.runId);
  const hasEvent = (type, match = () => true) => runEvents().some((event) => event.type === type && match(event.data));

  before(async () => {
    // Chat and embeddings go to the Ollama stand-in; embeddings proxy to a
    // port where nothing listens, so retrieval is lexical and nothing real
    // is called.
    ollama = await startFakeOllama({ embedUrl: await deadUrl() });
    process.env.OLLAMA_URL = ollama.url;
    control = await startFakeControl();
    process.env.CONTROL_URL = control.url;
    server = await startServer();
    api = await registeredSession(server.base);
    ctx.ownerId = (await api('GET', '/api/auth/session')).data.userId;

    // The local model, scripted by what each call is: the plan; then the
    // chooser, which sees the step number and the graph slice. Step 2 builds
    // its artifact from the fit the sandbox printed in step 1, read back out
    // of the slice; if the result did not reach the graph, it has nothing to
    // save and replies with something that is not a choice.
    ollama.state.respond = (request) => {
      if (request.format !== 'json') return PLAN;
      const prompt = request.messages.map((message) => message.content).join('\n');
      const step = Number(/This is step (\d+)\./.exec(prompt)?.[1]);
      if (step === 1) return JSON.stringify({ capability: 'code.run_generated', input: { language: 'node', code: FIT_CODE }, summary: 'Fit g from the pendulum data' });
      if (step === 2) {
        const fit = /g = (\d+\.\d{3}) m\/s\^2/.exec(prompt)?.[1];
        if (!fit) return 'I could not find the fit.';
        return JSON.stringify({
          capability: 'graph.write_artifact',
          input: { title: 'Pendulum fit', content: `From the lab data, g = ${fit} m/s² (least squares of T² against L through the origin).` },
          summary: 'Save the fit for the lab report',
        });
      }
      return JSON.stringify({ done: true, summary: 'Fitted g and saved it for the lab report.' });
    };

    // The engine's own worker and scheduler, on the engine's event bus, as
    // the engine starts them; the scheduler's clock is the test's.
    worker = createWorker({ adapters: defaultAdapters(), online: () => true, embed: false, pollMs: 25, leaseMs: 30_000, heartbeatMs: 50, onError: () => {} });
    worker.start();
  });

  after(async () => {
    streamAbort?.abort();
    await worker?.stop();
    delete process.env.CONTROL_URL;
    process.env.OLLAMA_URL = 'http://localhost:11434';
    await server?.close();
    await control?.close();
    await ollama?.close();
  });

  test('sign in through the control link, make an agent and a weekly task, and the scheduler fires it', async () => {
    // 1. Sign-in: the engine starts a loopback + PKCE flow; the browser comes
    // back with a code; the engine exchanges it with its verifier.
    const started = await api('POST', '/api/control/signin');
    assert.equal(started.status, 200);
    const signin = new URL(started.data.url);
    assert.equal(signin.origin, control.url);
    const token = newDeviceToken();
    control.state.me.set(token, meFor('engineer', { email: 'student@scope.test' }));
    control.state.exchange = (body) =>
      body?.code === 'one-time-code' && createHash('sha256').update(body.code_verifier).digest('base64url') === signin.searchParams.get('code_challenge')
        ? { token, account: { id: 'acct-student', email: 'student@scope.test', plan: 'engineer', devMode: false } }
        : null;
    const callback = new URL(signin.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'one-time-code');
    callback.searchParams.set('state', signin.searchParams.get('state'));
    const landing = await fetch(callback);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Signed in to Scope Studio/);
    const status = (await api('GET', '/api/control/status')).data;
    assert.deepEqual([status.signedIn, status.plan, status.account.email], [true, 'engineer', 'student@scope.test']);
    assert.ok(control.state.requests.some((r) => r.path === '/v1/me' && r.auth === `Bearer ${token}`), 'the plan was read with the new device token');

    // The activity stream, open for the rest of the test.
    streamAbort = new AbortController();
    const response = await api.raw('GET', '/api/workspace/events', undefined, { signal: streamAbort.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    stream = readEvents(response);

    // 2. The project's material: a private lab note.
    const note = await api('POST', '/api/nodes', { type: 'spec', content: LAB_NOTE, project: PROJECT, privacy: 'local' });
    assert.equal(note.status, 201, JSON.stringify(note.data));
    ctx.noteId = note.data.id;

    // 3. The agent: supervised, so model-written code needs the person's
    // approval; it may use the cloud on its plan's terms.
    const agent = await api('POST', '/api/agents', {
      name: 'Lab helper',
      role: { title: 'Lab assistant', description: 'Analyses lab data', embodiment: 'You analyse lab data carefully and save what you find.', tags: ['graph', 'sandbox'] },
      level: 'supervised',
      modelPolicy: 'local_cloud',
      scopes: { read: { projects: [PROJECT], sources: ['*'] }, write: { projects: [PROJECT] } },
    });
    assert.equal(agent.status, 201, JSON.stringify(agent.data));
    ctx.agentId = agent.data.agent.id;
    assert.equal(agent.data.agent.state, 'active');

    // 4. A recurring task: its first slot is the next Monday at 09:30 UTC.
    const created = new Date();
    const task = await api('POST', '/api/tasks', { agentId: ctx.agentId, title: 'Weekly lab fit', instructions: INSTRUCTIONS, project: PROJECT, schedule: SCHEDULE });
    assert.equal(task.status, 201, JSON.stringify(task.data));
    ctx.taskId = task.data.task.id;
    const slot = new Date(task.data.task.nextRunAt);
    assert.ok(slot > created);
    assert.equal(slot.toISOString(), nextRunAt(SCHEDULE, created).toISOString());

    // 5. The scheduler: nothing before the slot, one run at it, and the same
    // slot is never queued twice.
    let clock = new Date(slot.getTime() - 60_000);
    const scheduler = createScheduler({ now: () => clock, onQueued: () => worker.poke(), onError: (err) => assert.fail(err) });
    assert.deepEqual(await scheduler.tick(), []);
    clock = new Date(slot.getTime() + 1_000);
    const queued = await scheduler.tick();
    assert.equal(queued.length, 1);
    [ctx.runId] = queued;
    assert.deepEqual(await scheduler.tick(), []);
    const { rows: [run] } = await server.pool.query('SELECT task_id, scheduled_for, instructions, project FROM agent_runs WHERE id = $1', [ctx.runId]);
    assert.deepEqual([run.task_id, run.scheduled_for.toISOString(), run.instructions, run.project], [ctx.taskId, slot.toISOString(), INSTRUCTIONS, PROJECT]);
    const advanced = (await api('GET', `/api/tasks/${ctx.taskId}`)).data.task.nextRunAt;
    assert.equal(advanced, nextRunAt(SCHEDULE, clock).toISOString(), 'the next slot is a week on');
  });

  test('the run plans, runs nothing unapproved, and asks for approval', async () => {
    assert.ok(ctx.runId, 'the run was queued');
    await waitFor(() => hasEvent('approval.requested'), 'the approval request');
    const { data } = await api('GET', '/api/approvals?status=pending');
    assert.equal(data.approvals.length, 1, 'one approval: the code, and no cloud request for a private run');
    const [approval] = data.approvals;
    assert.deepEqual([approval.runId, approval.capability], [ctx.runId, 'code.run_generated']);
    assert.match(approval.summary, /Fit g from the pendulum data/);
    ctx.approvalId = approval.id;

    const run = (await api('GET', `/api/agent-runs/${ctx.runId}`)).data.run;
    assert.equal(run.status, 'waiting_approval');
    assert.deepEqual(run.steps.map((step) => [step.index, step.kind, step.capability, step.status]), [
      [0, 'plan', null, 'done'],
      [1, 'act', 'code.run_generated', 'waiting_approval'],
    ]);
    assert.equal(run.steps[1].output, null, 'the code has not run');
  });

  test('approving it resumes the run, which runs the code in the sandbox, saves an artifact and succeeds', async () => {
    const resolved = await api('POST', `/api/approvals/${ctx.approvalId}`, { decision: 'approve' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.approval.status, 'approved');
    await waitFor(() => hasEvent('run.finished'), 'the run to finish');

    const run = (await api('GET', `/api/agent-runs/${ctx.runId}`)).data.run;
    assert.equal(run.status, 'succeeded', run.error ?? '');
    assert.deepEqual(run.steps.map((step) => [step.index, step.kind, step.capability, step.status]), [
      [0, 'plan', null, 'done'],
      [1, 'act', 'code.run_generated', 'done'],
      [2, 'act', 'graph.write_artifact', 'done'],
      [3, 'act', null, 'done'],
    ]);
    const ran = run.steps[1].output;
    assert.equal(ran.ok, true, ran.output);
    assert.match(ran.output, /^g = 9\.\d{3} m\/s\^2/);
    ctx.fit = /g = (\d+\.\d{3})/.exec(ran.output)[1];

    // Everything ran on the local model: the context was private, so neither
    // the plan nor any step was offered to the platform, though the account
    // is on Engineer and the agent may use the cloud.
    assert.ok(run.steps.every((step) => step.adapter === null || step.adapter === 'local'));
    assert.equal(control.cloudRequests().length, 0);
    assert.equal(ollama.state.chatRequests.length, 4, 'the plan and three choices');
    // The role can run model-written code, so every chooser call had the
    // code-writing output limit; the plan its own; all with an 8,192-token
    // context, so a long prompt and reply are not truncated.
    assert.deepEqual(
      ollama.state.chatRequests.map((request) => [request.format ?? 'text', request.options.num_predict, request.options.num_ctx]),
      [['text', 800, 8192], ['json', 1500, 8192], ['json', 1500, 8192], ['json', 1500, 8192]]
    );
    const { rows: costs } = await server.pool.query('SELECT DISTINCT adapter FROM agent_run_costs WHERE run_id = $1', [ctx.runId]);
    assert.deepEqual(costs, [{ adapter: 'local' }]);
    assert.equal(run.costUsd, 0);
  });

  test('the artifact is in the graph, made from the private note, and private', async () => {
    const { data } = await api('GET', `/api/nodes?project=${PROJECT}&type=artifact`);
    const artifacts = Array.isArray(data) ? data : data.nodes;
    assert.equal(artifacts.length, 1);
    const [artifact] = artifacts;
    assert.match(artifact.content, /^Pendulum fit\n\nFrom the lab data, g = /);
    assert.ok(artifact.content.includes(`g = ${ctx.fit} m/s²`), 'the saved result is the one the sandbox printed');

    const { rows: [row] } = await server.pool.query('SELECT owner_id, source, project, privacy FROM nodes WHERE id = $1', [artifact.id]);
    assert.deepEqual(row, { owner_id: ctx.ownerId, source: 'agent', project: PROJECT, privacy: 'local' });
    const { rows: edges } = await server.pool.query(
      'SELECT source_id, target_id, type FROM node_relationships WHERE target_id = $1 OR source_id = $1',
      [artifact.id]
    );
    assert.ok(edges.some((edge) => edge.source_id === artifact.id && edge.target_id === ctx.noteId && edge.type === 'derived_from'), 'derived from the lab note');
    const { rows: [step] } = await server.pool.query('SELECT node_ids FROM agent_run_steps WHERE run_id = $1 AND index = 2', [ctx.runId]);
    assert.ok(step.node_ids.includes(artifact.id));
    assert.ok(edges.some((edge) => edge.target_id === artifact.id && edge.type === 'produces' && step.node_ids.includes(edge.source_id)), 'produced by its step');
    // Every node the run wrote learned from the private note, so none of it
    // may leave the machine either.
    const { rows: written } = await server.pool.query(
      'SELECT DISTINCT privacy FROM nodes WHERE id IN (SELECT unnest(node_ids) FROM agent_run_steps WHERE run_id = $1)',
      [ctx.runId]
    );
    assert.deepEqual(written, [{ privacy: 'local' }]);
  });

  test('the activity stream delivered the run’s events in protocol order', async () => {
    const framed = stream.events.filter((entry) => entry.data.runId === ctx.runId);
    for (const entry of framed) {
      assert.equal(entry.event, entry.data.type, 'the SSE event line names the type');
      assert.equal(entry.id, entry.data.id, 'the SSE id is the event id');
      assert.equal(entry.data.agentId, ctx.agentId);
    }
    const seqs = framed.map((entry) => entry.data.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'in the order they were published');
    assert.equal(new Set(seqs).size, seqs.length, 'each once');

    const stepIds = (await server.pool.query('SELECT id FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [ctx.runId])).rows.map((row) => row.id);
    const named = (event) => {
      const step = stepIds.indexOf(event.data.stepId);
      return step === -1 ? event.type : `${event.type}#${step}`;
    };
    assert.deepEqual(runEvents().map(named), [
      'run.queued',
      'run.started',
      // The plan: read, act (one model call), verify, write back.
      'step.started#0',
      'cost',
      'step.verified#0',
      'node.written',
      'step.finished#0',
      // The chooser picks model-written code, which is not run but parked.
      'step.started#1',
      'cost',
      'step.started#1',
      'approval.requested',
      'run.paused',
      // The person approves; the run is queued and resumed where it parked.
      'approval.resolved',
      'run.queued',
      'run.resumed',
      'step.output#1',
      'step.verified#1',
      'node.written',
      'step.finished#1',
      // The artifact.
      'step.started#2',
      'cost',
      'step.started#2',
      'step.output#2',
      'step.verified#2',
      'node.written',
      'node.written',
      'step.finished#2',
      // Done, with the summary kept as a finding.
      'step.started#3',
      'cost',
      'node.written',
      'node.written',
      'step.finished#3',
      'run.finished',
    ]);
    const finished = runEvents().at(-1);
    assert.deepEqual(finished.data, { status: 'succeeded' });
    assert.deepEqual(runEvents().find((event) => event.type === 'approval.resolved').data, { approvalId: ctx.approvalId, status: 'approved' });
    const written = runEvents().filter((event) => event.type === 'node.written').map((event) => event.data.type);
    assert.deepEqual(written, ['plan', 'step', 'step', 'artifact', 'step', 'finding']);
  });
});
