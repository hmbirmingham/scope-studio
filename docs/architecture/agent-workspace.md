# Agent workspace

Status: contract (Wave 0). The interfaces, tables and event format in this
document are what the parallel paths build against. A change to any of them
lands as its own pull request that updates this document in the same diff.

## Why the graph is the agent's memory

A cloud agent keeps every step of a long task in its context window, so the
cost of step 40 includes steps 1 to 39, and a small local model cannot run the
task at all. Scope Studio keeps the work in the knowledge graph instead. Each
step reads a small, packed slice of the graph (the same hybrid retrieval the
conversation uses, boosted toward the nodes this run created or touched),
acts once through a declared capability, verifies the result, and writes what
it learned back as linked nodes. The next step starts from the graph, not from
a transcript, so its context is the same size at step 40 as at step 2. That is
what lets an 8B model on a laptop run long engineering, research and code work
offline, and what keeps the cloud for the few steps that need it.

## Concepts

### Agent

An agent is a user-owned, fully editable record:

| Field | Meaning |
|---|---|
| `name` | What the user calls it. |
| `role` | `{ template, title, description, embodiment, tags }`. `template` is the key of the built-in role it started from (or `null` for a custom role); the rest are a copy the user can edit freely. `embodiment` is the persona text the planner is given. `tags` are the capability tags the role may use (see Plug-in capabilities). |
| `level` | Permission level: `manual`, `supervised`, `sandboxed`, `agentic`. New agents are `supervised`. |
| `overrides` | Per-capability `allow` / `ask` / `deny` that replace the level's default for that capability. |
| `scopes` | `{ read: { projects, sources }, write: { projects } }`. `projects` is a list of project names or `['*']`; `sources` is a list of plug-in sources (`github`, `kicad`, …) or `['*']`. |
| `modelPolicy` | `local_only`, `local_cloud` (cloud for planning and hard steps where the plan allows it) or `own_key` (Key Pro: the user's own Anthropic key for planning and hard steps). |
| `budget` | Per-run limits `{ maxTokens, maxUsd, maxWallMs, maxSteps }`. A run may override any of them. A run stops with `budget_exceeded` at the first limit it crosses; `maxSteps` defaults to 50 so every run has a step limit. |
| `state` | `active`, `paused` (no new steps start) or `killed` (the kill switch: every run is stopped and nothing new starts until the user re-activates the agent). |
| `color` | The colour the agent's cursor uses on the map. |

Built-in role templates live in code (`server/src/workspace/roles.js`), not in
the database, so a template can be improved without a migration and is never
lost by a table truncate. Starting from a template copies it into the agent.
A user's own reusable roles are stored in `agent_roles`.

| Template | Tags |
|---|---|
| Researcher | `graph`, `research`, `web` |
| Builder | `graph`, `code`, `scripts`, `vcs` |
| Debugger | `graph`, `code`, `scripts`, `sandbox` |
| Physicist | `graph`, `physics`, `sandbox` |
| Hardware Engineer | `graph`, `kicad` |
| CAD Designer | `graph`, `cad`, `sandbox` |

### Permission spectrum

Capabilities an agent can exercise:

| Capability | What it covers |
|---|---|
| `read_graph` | Read nodes in the agent's read scope. |
| `write_notes` | Write plan, step, finding, decision, artifact and question nodes. |
| `edit_files` | Change files (in a sandbox worktree, or the user's checkout). |
| `run_scripts` | Run a verifier or a script the project declares (never a shell string). |
| `run_generated_code` | Run code a model wrote, only inside the OS sandbox. |
| `web` | Fetch from or search the web. |
| `cloud_model` | Send a step to a cloud model. |
| `open_pr` | Open a pull request with the agent's changes. |
| `apply_merge` | Apply a result to the user's checkout or merge a pull request. |

Default decision by level:

| Capability | Manual | Supervised | Sandboxed autonomous | Fully agentic |
|---|---|---|---|---|
| `read_graph` | ask | allow | allow | allow |
| `write_notes` | ask | allow | allow | allow |
| `edit_files` | ask | ask | allow in sandbox, else ask | allow |
| `run_scripts` | ask | ask | allow in sandbox, else ask | allow |
| `run_generated_code` | ask | ask | allow in sandbox | allow in sandbox |
| `web` | ask | ask | ask | allow |
| `cloud_model` | ask | ask | ask | allow |
| `open_pr` | ask | ask | ask | allow |
| `apply_merge` | ask | ask | ask | allow |

`can(agent, capability, context) → 'allow' | 'ask' | 'deny'`
(`server/src/workspace/permissions.js`) is the only place that decides. It
applies, in order:

1. **Hard denials** that no level or override can lift. They fail closed: a
   context field the caller leaves out never widens access.
   - the agent is not `active` (`killed`, `paused`, or anything unexpected);
   - the capability is unknown;
   - `run_generated_code` outside the sandbox (`context.inSandbox !== true`);
   - `read_graph` outside the read scope (`inReadScope`): the project must be
     in scope, and a read that names no `source` is allowed only for an agent
     whose read sources are `['*']`;
   - `write_notes`, `edit_files`, `run_scripts`, `open_pr`, `apply_merge` on a
     project outside the write scope (scripts run in the project's checkout or
     its sandbox copy, so running one counts as writing to it);
   - `web` or `cloud_model` unless the caller says it is online (`context.online === true`);
   - `cloud_model` with `modelPolicy: 'local_only'`, or unless the caller says
     the step's context holds no private node (`context.privateContext === false`).
2. **The agent's override** for that capability, if any.
3. **The level default** from the table above.

`ask` creates an approval; the step waits until the user approves or rejects it.

Retrieval does not call `can()` per node: the read stage filters its
candidates with `inReadScope(agent, node)`, so a packed slice never holds a
node outside the read scope. A capability that reads one plug-in's data asks
`can(agent, 'read_graph', { project, source })` itself.

### Task and Run

A **task** is the work: instructions, the agent that does it, the project it
targets, and an optional cron-style `schedule` (five fields, UTC) for a
recurring task. A **run** is one execution of a task (or of an ad-hoc
instruction). A run is made of **steps**.

### Graph write-back

Runs write their working memory into the graph with these node types (added
to `nodes.type`; `decision` already existed):

| Type | Written when |
|---|---|
| `plan` | The run plans; one per run, revised in place. |
| `step` | A step finishes; its outcome and what it touched. |
| `finding` | Something learned that later steps or later runs should know. |
| `decision` | A choice made, with the reason. |
| `artifact` | A produced file, diff, table, figure or report. |
| `question` | Something only the user can answer. |

Relationship types added to `node_relationships.type`:

| Type | From → to |
|---|---|
| `derived_from` | finding / decision / artifact → the source nodes it was read from |
| `produces` | step → the finding / decision / artifact / question it wrote |
| `follows` | step → the previous step |
| `answers` | finding / decision → the question it resolves |

`part_of` (step → plan) already exists. Write-back nodes have
`source = 'agent'`, the run's project, and **inherit privacy**: if any node a
write-back node was derived from is `local`, so is the new node
(`inheritPrivacy` in `server/src/workspace/nodeTypes.js`). Private nodes never
leave the machine, so neither does anything an agent learned from them.

### Run-step protocol

Every step follows the same five stages, and the runner never skips one:

1. **Read**: pack a slice of the graph for this step (retrieval with run-scoped
   boosts toward the plan and nodes this run wrote, within the step's token
   budget).
2. **Act**: exercise exactly one capability. `can()` decides first; `ask`
   records an approval and parks the step in `waiting_approval`.
3. **Verify**: run the capability's verifiers (tests, build, typecheck, ERC,
   unit checks, citation checks…). A capability with no verifier is verified
   by its own result schema only.
4. **Write back**: only after verification passes, write the step node and its
   findings / artifacts, linked as above. A failed verification writes a
   `step` node marked failed and no findings.
5. **Checkpoint**: persist the step and the run's position in one transaction,
   so a restart resumes from the next step, never repeats a finished one.

Planning may use the cloud when the model policy and plan allow it; execution
steps run on the local adapter unless the step is marked hard and the policy
allows the cloud.

The runner (`server/src/workspace/runner/`) implements this as follows.

- The first step of a run is the planning step: writing the plan is its one
  act (`can(write_notes)`), and it creates the run's `plan` node.
- Every later step's act starts with the **step chooser**, one model call that
  sees the goal, the packed slice and the role's capabilities and replies with
  strict JSON `{ capability, input, hard?, done?, summary? }`. The reply is
  validated (the capability is one the role may use, the input matches its
  schema's required fields and types) before `can()` is asked. `done: true`
  with no capability ends the run as `succeeded`. `hard` marks the step hard
  for the model calls its capability makes through `ctx.model`.
- The slice has a fixed budget (1,500 tokens, 8 nodes). The run's plan and its
  most recent notes compete for it with boosted scores, so the next step reads
  what the last one learned. They are the run's own memory, so they are
  readable to it whatever its read sources say (they carry source `agent`);
  the project scope still applies.
- A step that cannot proceed (invalid chooser reply, `deny`, a capability
  error, failed verification) is failed, and its step node records why, so the
  next step sees it. Five failed steps in a row fail the run.
- A kill aborts the step in flight. A pause lets the step in flight finish and
  checkpoint, and stops at the next step boundary.

### Plug-in capability contract

A plug-in (`server/src/plugins/<name>/`) declares what it can do:

```js
export default {
  name: 'code',
  capabilities: [
    {
      name: 'code.search',          // unique, namespaced by plug-in
      tags: ['code'],               // roles reference tags, never plug-in names
      permission: 'read_graph',     // the capability `can()` is asked about
      input: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      verifiers: [],                // names of verifiers run after this capability
      async run(input, ctx) { … },  // returns { output, touchedNodeIds?, artifacts?, findings?, decisions?, questions? }
    },
  ],
  verifiers: [
    { name: 'code.tests', tags: ['code'], async verify(result, ctx) { … } }, // → { ok, detail }
  ],
};
```

A capability may also declare `source` (the plug-in data it reads), which the
runner passes to `can()`; without it a `read_graph` capability is allowed only
for an agent whose read sources are `['*']`. `findings`, `decisions`,
`questions` and `artifacts` in the result (each a string or
`{ content, name? }`) become write-back nodes once the step is verified.

`registerPlugin` (`server/src/workspace/capabilities.js`) validates the
declaration and refuses duplicates. A role's tags select the capabilities an
agent may use, so a new vertical (KiCad, research, physics, CAD) becomes
available to every role that carries its tag without touching the role.

`ctx` gives a capability only what the protocol allows: `ownerId`, `agent`,
`run`, `step`, `project`, `localPath`, `sandbox` (when the step runs in one),
`model` (a ModelPort), `signal` (aborts on kill or budget), and `emit(event)`.

### ModelPort

One interface, three adapters (`server/src/workspace/modelPort.js`):

```js
port.name      // 'local' | 'own_key' | 'platform'
port.offline   // true only for 'local'
port.stream({ messages, maxTokens, signal, purpose })
  // yields { text } … then { done: true, usage, costUsd, model }
```

- **local**: Ollama on this machine. Always available offline. Cost 0.
- **own_key**: Anthropic directly with the user's Key Pro key.
- **platform**: the control plane's `POST /v1/cloud/messages` with the device
  token (Wave 2, path F). A fresh `requestId` on every retry.

`selectAdapter({ policy, purpose, hard, online, plan, hasOwnKey, privateContext })`
returns which adapter a step uses and why. The runner calls `selectAdapter`
then `port.stream`; it never branches on which adapter it got, with one
exception below.

`selectAdapter` decides what the plan and policy make possible; `can()` decides
what this agent is permitted. Order for every model call:

1. `selectAdapter(…)`. If it returns `local`, use local; `can()` is not asked.
2. Otherwise ask `can(agent, 'cloud_model', { project, online, privateContext })`.
   - `allow`: use the cloud adapter.
   - `ask`: the runner opens **one** approval per run ("use the cloud for this
     run's planning and hard steps") and uses local until it is approved; an
     approved request covers the rest of the run, a rejected one keeps it local.
   - `deny`: use local.
3. If the cloud adapter refuses with `platform_unavailable` (signed out, offline,
   allowance exhausted), the runner uses local for that call and records the
   adapter actually used on the step. This is the one place the runner looks at
   an adapter's outcome.

### Activity event stream

`GET /api/workspace/events[?runId=…]` is Server-Sent Events, for one run or
for all of the user's runs. Each event:

```
id: <boot>-<seq>
event: <type>
data: {"v":1,"id":"<boot>-<seq>","seq":<seq>,"runId":"…","agentId":"…","at":"<ISO time>","type":"<type>","data":{…}}
```

`seq` is one counter for the whole engine and `boot` names the engine process,
so a client reconnecting with `Last-Event-ID` gets what it missed from a
bounded replay buffer, for one run or all of them; an id from an earlier boot
replays everything still buffered. A subscriber whose connection fails is
dropped without affecting the run. After a restart the activity tab reloads
the run (and its steps) over HTTP, which is the durable record; events are
the live view. Types: `run.queued`, `run.started`, `run.paused`,
`run.resumed`, `run.finished` (`{ status }`), `step.started`
(`{ stepId, index, capability }`), `step.output` (`{ stepId, text }`),
`step.verified` (`{ stepId, verifier, ok, detail }`), `step.finished`
(`{ stepId, status }`), `approval.requested` (`{ approvalId, capability, summary }`),
`approval.resolved` (`{ approvalId, status }`), `node.written`
(`{ nodeId, type }`), `node.touched` (`{ nodeIds }`), `cost`
(`{ tokens, usd, adapter }`), `budget.exceeded` (`{ limit }`).

Events stay on the machine. Prompt and answer text never goes to the control
plane's ledger.

## Storage

Migrations `020_workspace_node_types.sql` and `021_agent_workspace.sql` (Wave 0)
create the shared tables: `agent_roles`, `agents`, `tasks`, `agent_runs`,
`agent_run_steps`, `agent_approvals`. Every table carries `owner_id` with
`ON DELETE CASCADE` (steps through their run), so deleting a user removes
their agents and runs, and the test helper's truncate of `users` clears them.
Tasks, runs and approvals reference their agent together with its owner, so
none can point at another user's agent.

`agent_runs` is the durable queue: a worker claims the oldest `queued` run with
`FOR UPDATE SKIP LOCKED`, increments `attempts` and holds a lease
(`lease_owner`, `lease_until`); a run whose lease expired is reclaimed after a
crash, and a run claimed more than three times is failed rather than
reclaimed forever. `attempts` counts claims since the run last made progress:
a checkpoint, parking for an approval or a clean hand-back resets it, so a
long run with many approvals is not mistaken for one that keeps crashing. A recurring run records the schedule slot it was queued
for in `scheduled_for`, unique per task, so two schedulers cannot enqueue the
same slot. At most one approval per step can be pending.

Write-back nodes carry `owner_id = run.owner_id`.

Path B adds (migrations 025–027): `agent_run_costs`, the per-run cost ledger,
one row per model call (`purpose`, `adapter`, `fallback_from`, `model`, token
counts, `usd`) and never any prompt or answer text, from which the run's
`tokens_used` and `cost_usd` are summed; `agent_run_steps.detail` and `.error`,
the runner's own record of a step (the chooser's decision, the nodes it read,
adapter fallbacks); and a unique index that allows one run-level cloud
approval (`step_id` NULL, capability `cloud_model`) per run.

The scheduler enqueues a due task with `scheduled_for = next_run_at` and
advances `next_run_at` in the same transaction. Missed slots are not replayed
(after downtime a task runs once, then continues from the next slot after
now), a paused or killed agent's slot passes without a run, and a schedule
that no longer parses stops the task (`next_run_at` NULL).

## HTTP surface

| Mount | Owner |
|---|---|
| `/api/agents` | Path A — agents, roles, kill switch, pause/resume |
| `/api/tasks` | Path A — tasks and schedules |
| `/api/approvals` | Path A — the approvals inbox |
| `/api/agent-runs` | Path B — start, list, inspect, cancel runs |
| `/api/workspace/events` | Path B — the SSE stream |

(`/api/runs` is the existing approval-gated script run and is unchanged.)

## Reserved migration numbers

| Numbers | Owner |
|---|---|
| 020–021 | Wave 0 (this contract) |
| 022–024 | A. Agents, tasks, permissions |
| 025–027 | B. Runner |
| 028–029 | C. Capabilities and code vertical |
| 030 | E. Task benchmark |
| 031–032 | F. Engine ↔ control (engine side); control side 007–008 |
| 040–049 | KiCad |
| 050–059 | Research |
| 060–069 | Physics |
| 070–079 | CAD |

## Client

`client/src/workspace/tabs.js` is the tab registry: a module registers
`{ id, label, order, Component }` and the workspace strip beside the
conversation renders it. With nothing registered the strip does not render,
so Wave 0 changes nothing the user sees.

Visual language for agents on the map: obsidian circles with no hue at rest;
the agent's colour appears only on the nodes it is touching or just wrote.

## Run lifecycle across paths

Several modules change a run's status, so the transitions are fixed here.
Every update is conditional on the status it expects (`UPDATE … WHERE status = …`),
so two writers can never both win.

| From | To | Who | When |
|---|---|---|---|
| — | `queued` | `/api/agent-runs` (start) or the scheduler | A run is requested, or a recurring task is due. |
| `queued` | `running` | worker | Claimed with `FOR UPDATE SKIP LOCKED`; sets `lease_owner`, `lease_until`, `started_at`. |
| `running` | `running` | worker | Lease renewed at each step boundary. An expired lease is reclaimed by any worker from the last checkpoint. |
| `running` | `waiting_approval` | worker | `can()` returned `ask`: the worker inserts an `agent_approvals` row for the step, parks the step in `waiting_approval`, releases the lease. |
| `waiting_approval` | `queued` | `/api/approvals/:id` (resolve) | The last pending approval of the run was approved or rejected. The worker resumes the parked step and reads the decision from `agent_approvals`; a rejection marks the step `rejected` and the planner continues without it. The run-level cloud approval (`step_id` NULL) never holds a run in `waiting_approval` (the run uses local meanwhile), so only step approvals count here. |
| `queued` / `running` / `waiting_approval` | `paused` | `/api/agents/:id/pause` | The agent is paused. A running worker sees it at the next step boundary and stops without overwriting it. |
| `paused` | `queued` | `/api/agents/:id/resume` | A run that was waiting for approval comes back `queued`; the worker finds the step's approval still pending and parks it again. |
| any non-terminal | `killed` | `/api/agents/:id/kill`, `/api/agent-runs/:id/cancel` | The kill switch. Sets `finished_at` and marks the run's pending approvals `expired`. The worker checks the run's status before each stage and aborts the step's `signal` when it sees `killed`. |
| `running` | `failed` | worker | A reclaimed run whose `attempts` exceeds 3. |
| `running` | `paused` / `killed` | worker | At a step boundary the worker finds the agent paused or killed but the run not yet marked (a race with the agents API). A worker-made kill also expires the run's pending approvals. |
| `running` | `queued` | worker | The worker is stopping (engine shutdown): it hands the run back at a step boundary and releases the lease. |
| `running` | `succeeded` / `failed` / `budget_exceeded` | worker | Terminal. Sets `finished_at`. |

The worker publishes the matching `run.*` event for transitions it makes;
the routes publish the events for transitions they make.

## HTTP shapes

All bodies are JSON with camelCase keys; ids are UUIDs; errors are
`{ error: '<code>', message? }` with 400 (validation), 404 (not this owner's,
or missing), 409 (wrong state).

**Agent**
`{ id, name, role: { template, title, description, embodiment, tags }, level, overrides, scopes, modelPolicy, budget: { maxTokens, maxUsd, maxWallMs }, state, color, createdAt, updatedAt }`

- `GET /api/agents` → `{ agents: [Agent] }`
- `GET /api/agents/templates` → `{ templates: [Role] }` (built-in) and `GET /api/agents/roles` → `{ roles: [Role & { id }] }` (the user's own); `POST/PATCH/DELETE /api/agents/roles[/:id]`
- `POST /api/agents` `{ name, template? | role?, level?, overrides?, scopes?, modelPolicy?, budget?, color? }` → 201 `{ agent }`
- `GET /api/agents/:id`, `PATCH /api/agents/:id` (any field above except `state`), `DELETE /api/agents/:id`
- `POST /api/agents/:id/pause | /resume | /kill | /reactivate` → `{ agent }`
- `GET /api/agents/:id/can?capability=&project=&source=&inSandbox=&online=&privateContext=` → `{ decision, reason }` (for the UI's capability grid; an omitted flag takes the cautious value, exactly as an omitted field in the runner's context does)

**Task**
`{ id, agentId, title, instructions, project, schedule, nextRunAt, enabled, createdAt, updatedAt }`

- `GET /api/tasks[?agentId=]` → `{ tasks }`; `POST /api/tasks` → 201 `{ task }` (a bad `schedule` is 400 with the cron error); `GET/PATCH/DELETE /api/tasks/:id`

**Run** (Path B)
`{ id, agentId, taskId, instructions, project, status, stepIndex, tokensUsed, costUsd, wallMs, budget, error, queuedAt, startedAt, finishedAt, planNodeId }`
and with `GET /api/agent-runs/:id` also `steps: [Step]`, where
Step is `{ id, index, kind, capability, status, input, output, verification, adapter, tokens, costUsd, nodeIds, startedAt, finishedAt }`.

- `GET /api/agent-runs[?agentId=&status=]` → `{ runs }`
- `POST /api/agent-runs` `{ taskId }` or `{ agentId, instructions, project? }`, either with an optional `budget` override → 201 `{ run }` (409 `agent_not_active` for a paused or killed agent)
- `GET /api/agent-runs/:id` → `{ run }`; `POST /api/agent-runs/:id/cancel` → `{ run }`

**Approval**
`{ id, agentId, runId, stepId, capability, summary, detail, status, createdAt, resolvedAt }`

- `GET /api/approvals[?status=pending]` → `{ approvals }`
- `POST /api/approvals/:id` `{ decision: 'approve' | 'reject' }` → `{ approval }` (409 if already resolved)

## Plug-in registration

`server/src/plugins/registry.js` lists the built-in plug-ins;
`registerBuiltInPlugins()` registers them once and is safe to call again. A
vertical adds itself there. Schedules use `server/src/workspace/cron.js`
(`validateCron`, `nextRunAt`).
