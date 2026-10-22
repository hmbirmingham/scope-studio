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
| `budget` | Per-run limits `{ maxTokens, maxUsd, maxWallMs, maxSteps }`. A run may tighten any of them but never loosen one: each limit is the smaller of the agent's and the run's (a limit only one of them sets is that one). A run stops with `budget_exceeded` at the first limit it crosses; `maxSteps` defaults to 50 so every run has a step limit. |
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
  with no capability ends the run as `succeeded`, and its `summary` is written
  as a `finding` produced by that final step, so later runs read the
  conclusion. `hard` marks the step hard for the model calls its capability
  makes through `ctx.model`.
- The chooser's reply is the step's act, so code a step writes is inside it.
  Its output limit is 600 tokens, or 1,500 when the role offers a capability
  that declares `writesCode: true` (it picks the capability in the same
  reply). The plan's limit is 800. The model router clamps every call's
  output limit (the plan, the chooser, and a capability's own call through
  `ctx.model`, with its own limit or none) to what the run's `maxTokens` has
  left, and every call is counted in the ledger as it was used. The local
  and own-key adapters pass that limit on; the platform adapter does not,
  since the control plane sets its own ceiling. Local calls ask for an
  8,192-token context, as chat does. A chooser reply cut off at its limit
  (the adapter's stop reason says so, or it used the whole limit) fails the
  step with `chooser_output_limit`, not as a format error.
- The slice has a fixed budget (1,500 tokens, 8 nodes). The run's plan and its
  most recent notes compete for it with boosted scores, so the next step reads
  what the last one learned. They are the run's own memory, so they are
  readable to it whatever its read sources say (they carry source `agent`);
  the project scope still applies.
- A step that cannot proceed (invalid chooser reply, `deny`, a capability
  error, a sandbox that cannot be made, failed verification) is failed, and
  its step node records why, so the next step sees it. Five failed steps in a
  row fail the run. Error text is cut to 500 characters wherever it is stored
  (the step's and the run's `error`, the step node's reason).
- A parked step that comes back approved is decided again before it runs: a
  hard denial since it parked, an override that now denies, or a role that no
  longer carries the capability fails the step (`denied: <reason>`,
  `capability_not_in_role`) instead of running it. An `ask` stands, since that
  is what the user approved.
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

A capability may also declare `writesCode: true` when its input carries code
the model writes (`code.edit`, `code.run_generated`, `physics.compute`,
`cad.parametric_edit`), which gives the step chooser its larger output
limit, and `source` (the plug-in data it reads), which the
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

### Sandbox

`ctx.sandbox` is the run's private copy of the project
(`server/src/workspace/sandbox/`), made by `createSandbox({ runId, repoPath,
carryUncommitted })` and removed by `removeSandbox(sandbox)` (or
`withSandbox(options, fn)`, which removes it however `fn` ends):

```js
{ id, root, gitDir, worktree, scratch, head, carried }
```

It lives in the app data directory (`SCOPE_DATA_DIR`, else
`$XDG_DATA_HOME/scope-studio` or `~/.local/share/scope-studio` on Linux,
`~/Library/Application Support/Scope Studio` on macOS) under
`sandboxes/<runId>/`, never inside the user's checkout or under a `.claude`
directory. It is an independent clone of HEAD (no hard links, no `origin`), not
a `git worktree`, so nothing in it shares the user's `.git`. Its git directory
sits beside `worktree/` and host-side git always names it explicitly, so code
in the OS sandbox cannot change the config that decides what git runs.

`runSandboxed({ command, args, cwd, timeoutMs, memoryMb, cpuSeconds, maxOutput,
writable?, readOnly?, protect?, signal? })` runs one process in the OS sandbox
and returns `{ ok, exitCode, signal, timedOut, limit, output, truncated,
durationMs, mechanism }`. Linux uses bubblewrap (no network, read-only system,
only `writable` writable, clear environment, prlimit limits); macOS uses
`sandbox-exec`. With neither it throws `sandbox_unavailable` and runs nothing.
When the engine runs as root the process runs as `nobody`; the `writable`
directories are handed to that uid before each run by a `find -P … chown -h`
inside a sandbox of its own, so a symlink left by an earlier run can never
make the engine change the owner of a host file.

The code plug-in (`server/src/plugins/code/`):

| Capability | Permission | Tags | Works in |
|---|---|---|---|
| `code.search` | `read_graph` | `code` | sandbox copy, else the checkout |
| `code.read` | `read_graph` | `code` | sandbox copy, else the checkout |
| `code.edit` | `edit_files` | `code` | sandbox copy only (`sandbox_required`) |
| `code.run_script` | `run_scripts` | `scripts` | declared scripts; in a sandbox copy only inside the OS sandbox (else `sandbox_unavailable`), in the user's checkout as `/api/runs` does |
| `code.run_generated` | `run_generated_code` | `sandbox` | OS sandbox only |

#### The run's sandbox

The runner (`server/src/workspace/runner/sandbox.js`) gives a run one sandbox
and reuses it for every step:

- A capability whose permission is `edit_files`, `run_scripts` or
  `run_generated_code` runs in the run's sandbox. The first such step that is
  allowed makes it: `createSandbox({ runId, repoPath: localPath })` (from the
  checkout's HEAD; uncommitted changes are not carried) when the project's
  `localPath` is a git checkout with a commit, otherwise
  `createScratchSandbox({ runId })` (a scratch directory only).
- `can()` is told `inSandbox: true` only when the capability really runs in
  one: always for `run_generated_code`, and for `edit_files` and
  `run_scripts` only when the project has a checkout to copy. An edit in a
  project with no git checkout is therefore `ask` at sandboxed autonomous.
- Once the run has a sandbox every capability gets it as `ctx.sandbox`
  (reads included), so a read after an edit sees the edited copy.
- A capability's verifiers run with the same `ctx`, under the capability's
  decision; no separate `can(run_scripts)` is asked for them.
- As soon as it is made, `checkpoint.sandbox = { root, kind, head }` is stored
  on the run (conditional on the worker's lease), so a resumed run finds it.
  The paths are always derived from the run id, never trusted from the row. A
  recorded sandbox that is gone (or half there) is removed and made again the
  next time a step needs it; the new copy starts from HEAD again.
- When the run reaches a terminal state the worker that ended it removes the
  sandbox and the record. A run that ended while no worker held it (killed
  while waiting for approval or paused) is swept by an idle worker
  (`sweepSandboxes`, at most once a minute). Parked, paused and handed-back
  runs keep theirs.
- A sandbox that cannot be made fails the step with `sandbox_error: …`.

Verifiers `code.typecheck`, `code.lint`, `code.build`, `code.tests` run the
matching declared script and return `{ ok, detail }`, or `{ ok: true,
unavailable: true, detail }` when the project declares none. In a sandbox copy
with no OS sandbox they run nothing and return `{ ok: false, unverified: true,
detail }`. They are attached to `code.edit`, so they run under that step's
`edit_files` decision; the script runs in the OS sandbox, in the copy the
step just edited.

The graph plug-in (`server/src/plugins/graph/`) serves the `graph` tag that
every built-in role carries:

| Capability | Permission | Tags | Does |
|---|---|---|---|
| `graph.write_artifact` | `write_notes` | `graph` | `{ title, content }` → one `artifact` note (content at most 3,800 characters), written back like any other once the step is verified. |

Reading needs no capability: every step already reads its packed slice.

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
  token (Wave 2, path F). A fresh `requestId` on every attempt, retries
  included. `platformAdapter({ ownerId, sources })` reads the owner's token
  itself; `stream` also takes `hard`, and a `purpose: 'plan'` call asks for the
  plan's hard-question model. `maxTokens` is not sent: the control plane sets
  the ceiling. Without a token, or when the control plane refuses, it throws
  `code: 'platform_unavailable'` (with `reason`: `signed_out`, `offline`,
  `allowance_exhausted`, …) before yielding anything. The worker makes it per
  run, for the run's owner, so a run never speaks with another user's token:
  an adapter entry may be a function of the run (`resolvePort` in
  `runner/models.js`).

The `plan` passed to `selectAdapter` (for a run as for chat) is the control
plane's, from `currentPlan(ownerId)` / `controlState(ownerId)` in
`server/src/control/plan.js`: `GET /v1/me`, cached per local user for five
minutes. Signed out, offline or unconfigured (`CONTROL_URL` unset, even with
a cached answer), it is `free`, so the run stays local. After a failed refresh the control plane is
not asked again for 30 seconds; a plan confirmed within the five minutes is
still served meanwhile. The same plan decides whether an agent may have
`modelPolicy: 'own_key'`. The engine keeps no billing tables of its own.

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
approval (`step_id` NULL, capability `cloud_model`) per run. The run's
`checkpoint` (JSONB) holds its position: the run's recent node ids, the
previous step node, the consecutive failure count, the last summary and,
while it has one, its sandbox record `sandbox: { root, kind, head }`.

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
| `/api/plugins/kicad` | KiCad — ingest jobs and kicad-cli status |

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
`{ id, label, order, Component, Badge? }` and the workspace strip beside the
conversation renders it (`Badge`, if given, is drawn inside the tab button,
as the approvals count is). `selectTab(id)` lets one tab open another. With
nothing registered the strip does not render, so Wave 0 changes nothing the
user sees.

The workspace UI (`client/src/workspace/`) registers three tabs: Agents
(builder, kill switch, tasks), Activity (a live step stream per run) and
Approvals. It holds one `EventSource` on `/api/workspace/events` for the
whole page; the browser's own retries resume with `Last-Event-ID`, the
client drops any replayed event it already delivered, and after every
reconnect it reloads the open run and the pending approvals over HTTP. When
the browser gives up (the source is closed) the client opens a new
`EventSource`, which cannot send `Last-Event-ID`, so that reload over HTTP is
what catches it up.

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
| `paused` | `queued` | `/api/agents/:id/resume` | Clears `lease_owner` and `lease_until`. A run that was waiting for approval comes back `queued`; the worker finds the step's approval still pending and parks it again. |
| any non-terminal | `killed` | `/api/agents/:id/kill`, `/api/agent-runs/:id/cancel` | The kill switch. Sets `finished_at` and marks the run's pending approvals `expired`. The worker checks the run's status before each stage and aborts the step's `signal` when it sees `killed`. |
| `running` | `failed` | worker | A reclaimed run whose `attempts` exceeds 3. |
| `running` | `paused` / `killed` | worker | At a step boundary the worker finds the agent paused or killed but the run not yet marked (a race with the agents API). A worker-made kill also expires the run's pending approvals. |
| `running` | `queued` | worker | The worker is stopping (engine shutdown): it hands the run back at a step boundary and releases the lease. Shutdown waits at most 10 s for that boundary (`stopWithin`); after that the engine exits, the run stays `running` and its lease expires, and any worker reclaims it from its last checkpoint as after a crash. |
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
- Deletes answer 204 with no body. A kill also publishes `approval.resolved` (`status: 'expired'`) for each approval it expires, before the `run.finished` events. `GET /api/agents/roles/:id` and `GET /api/approvals/:id` return one record.

**Task**
`{ id, agentId, title, instructions, project, schedule, nextRunAt, enabled, createdAt, updatedAt }`

- `GET /api/tasks[?agentId=]` → `{ tasks }`; `POST /api/tasks` → 201 `{ task }` (a bad `schedule` is 400 with the cron error); `GET/PATCH/DELETE /api/tasks/:id`

**Run** (Path B)
`{ id, agentId, taskId, instructions, project, status, stepIndex, tokensUsed, costUsd, wallMs, budget, error, queuedAt, startedAt, finishedAt, planNodeId }`
and with `GET /api/agent-runs/:id` also `steps: [Step]`, where
Step is `{ id, index, kind, capability, status, input, output, verification, adapter, tokens, costUsd, nodeIds, startedAt, finishedAt }`.

- `GET /api/agent-runs[?agentId=&status=]` → `{ runs }`
- `POST /api/agent-runs` `{ taskId }` or `{ agentId, instructions, project? }`, either with an optional `budget` → 201 `{ run }` (409 `agent_not_active` for a paused or killed agent). The run's `budget` is stored as given, but it can only tighten the agent's: the runner applies, per limit, the smaller of the two.
- `GET /api/agent-runs/:id` → `{ run }`; `POST /api/agent-runs/:id/cancel` → `{ run }`

**Approval**
`{ id, agentId, runId, stepId, capability, summary, detail, status, createdAt, resolvedAt }`

- `GET /api/approvals[?status=pending]` → `{ approvals }`
- `POST /api/approvals/:id` `{ decision: 'approve' | 'reject' }` → `{ approval }` (409 if already resolved)

## Measuring the edge

The task benchmark (`npm run benchmark:tasks`, `server/src/benchmark/tasks/`)
measures the claim at the top of this document on whole tasks rather than
chat turns. A task is a fixture, instructions, and an objective check; a code
task's check is the fixture's own `npm test`, run in the OS sandbox on the
arm's result with the fixture's `test/` and `package.json` put back first, so
a task counts as completed only when the tests pass and never because a model
said so (a run that claims success and fails the check is reported as such).

Arms:

| Arm | What runs |
|---|---|
| `scope_local` | `executeRun` with the code plug-in, the run sandbox and the OS sandbox; a Debugger agent at `sandboxed`, `modelPolicy: 'local_only'`; the graph is its only memory. |
| `scope_local_cloud` | The same with `local_cloud` on the Engineer plan's rules (`cloud_model` overridden to `allow`): planning goes to the platform model, steps stay local. |
| `baseline_sonnet`, `baseline_opus` | The standard full-transcript tool loop: the same tools (the code plug-in's capabilities, in an OS-sandboxed copy), one call per turn, every turn re-sending the whole conversation, with cache breakpoints on the previous and the new turn. |

Per task and arm the report records completion, cost, wall clock, actions
(the capability calls the arm attempted: a Scope run's steps that used a
capability, a baseline's tool calls; the one count comparable across arms),
the Scope runner's own steps apart from them (its plan and closing step
included; none for a baseline, whose turns are its model calls), model calls
and tokens (uncached input, cache writes, cache reads and output
separately), and every call's prompt size, from which it derives each arm's
context curve and its growth in tokens per step. Each ready task's check is
tested to fail before any work is done: the code and CAD checks on the
untouched fixture's content, the research and physics checks on an empty
answer. Totals give the cost per
completed task and how many times more it costs on each baseline.

`--dry` (the default, run in CI after the server tests) plays one scripted
sequence of capability calls through every arm with deterministic fake
ModelPorts, so the runner, the sandboxes, the pricing and the checks run for
real at $0 with no model or key. `--live-local` runs `scope_local` against
the real local model. `--live` needs `PLATFORM_ANTHROPIC_API_KEY` and an
explicit `--max-usd` of at most 5, and refuses otherwise. Private nodes never
leave the machine in any benchmark mode that makes a real cloud call: in a
`--live` run the arm's project is checked before every baseline request, and
once it holds a private node every tool result in the transcript, earlier
ones included, is replaced by a placeholder (its tools read only that
project); the row counts them as `privateResultsWithheld`. The Scope arms
rely on the runner's own privacy routing. The endurance benchmark's
paste-everything baselines (`npm run endurance`) count the private files a
cloud app would have pasted (`privateNodesWouldSend`); a dry run pastes them
in full to the local stand-in. A live run reads the privacy of everything
pasted again before every request and withholds the text of every private
node, in the new turn and in the re-sent transcript (`privateNodesWithheld`).
A live turn whose request carried a withheld node has no quality or citation
coverage and is left out of the quality comparison
(`turnsExcludedFromQuality`), and citation coverage is computed only from
the nodes actually sent. The Scope arms claim
only the run the harness created, so the benchmark is safe to point at a
database with other runs queued; it uses a throwaway account and deletes it.

What the dry run shows (six code tasks, scripted so every arm does the same
work): every arm completes 6/6; a completed task is priced at $0 on
`scope_local`, about $0.002 on `scope_local_cloud` (one Opus planning call),
$0.012 on the Sonnet baseline and $0.030 on the Opus baseline, with caching
on. On the longest task (14 actions) Scope's step prompt rises while the
slice fills and then holds at 1.5–1.8k tokens, while the baseline's grows
every turn to 4.3k. On the short tasks the slice is still filling when the
task ends, so there the two curves differ little: the saving comes from where
the tokens run (local, $0) more than from how many there are. The dry run
measures the harness and the economics, not model quality; that is what
`--live-local` and `--live` are for.

A research task (`research-cited-summary`) runs too: its paper set is
ingested into the graph for each arm, the Scope arms run as a Researcher and
the baselines get the Researcher's tools, and the check reads the final
answer against the task's key (it must name the method, cite the paper by
citekey and name the table, and every citation in it must resolve to an
ingested paper).

KiCad tasks are defined as pending acceptance gates
(why each is pending and which plug-in and verifier make it ready) and are
listed in every report, never run and never counted as failures. A ready
task of another vertical names the `role` both arms get (so the same
capabilities), the external tools it `requires`, and its own check: the CAD
task (`cad-bracket-hole-spacing`) is done by the CAD Designer, requires
CadQuery, and is checked by measuring the `bracket.stl` the run leaves
behind. Where a required tool is not installed the task is listed as
unavailable, like a pending gate: not run and not a failure.

The physics task (`physics-projectile-range`) is ready. A task may name its
role (`role: 'physicist'`); its fixture holds only the problem statement,
which the Scope arm ingests into the task's graph and the baseline gets in
its first message. Its check is a quantity check (`check.kind:
'quantity'`): the arm's last `physics.compute` result that passed its own
verifiers (a computation node was written), in metres, within 0.5% of a
reference kept in the catalog and never shown to an arm.

## Plug-in registration

`server/src/plugins/registry.js` lists the built-in plug-ins;
`registerBuiltInPlugins()` registers them once and is safe to call again; the
runner's worker calls it when it is created. A vertical adds itself there. Schedules use `server/src/workspace/cron.js`
(`validateCron`, `nextRunAt`).

## Verticals (Wave 4)

Each vertical is a plug-in in `server/src/plugins/<name>/` that adds ingest,
capabilities, verifiers, fixtures and benchmark tasks, and one line in
`server/src/plugins/registry.js`. Conventions every vertical follows:

- **Node vocabulary** comes from migration 039, shared by all four: KiCad
  `schematic`, `board`, `symbol`, `net`, `footprint`, `bom_row`; research
  `paper` (existing), `note`, `excerpt`; physics `derivation`, `computation`;
  CAD `part`, `assembly`. Sources `kicad`, `zotero`, `pdf`, `physics`, `cad`.
  Relationships `connects`, `implements`, `cites`, `contains`. A vertical that
  needs more adds them in a later migration that keeps every value above.
- **Ingest** writes nodes with `owner_id`, `project`, `external_id` (stable,
  so re-ingest updates rather than duplicates) and the source's privacy; it
  runs as a background job like GitHub ingest and never needs the network.
- **Capabilities** carry the vertical's tag (`kicad`, `research`, `physics`,
  `cad`), so every role with that tag can use them. Anything that executes
  model-written code or an external tool on model input runs through the
  sandbox (`runSandboxed`), never on the host.
- **Verifiers** that depend on an external tool (`kicad-cli`, `pdftotext`,
  Python packages, CadQuery) report `{ ok: true, unavailable: true, detail }`
  when the tool is missing, never a pass they did not check; tests cover the
  real tool when present and recorded outputs otherwise.
- **Fixtures** are small and permissively licensed; each fixture folder has a
  README naming its source and licence. No proprietary files.
- **Benchmark tasks** for the vertical move from `pending` to ready in the
  task benchmark when its plug-in and verifiers land.

Reserved migration numbers: KiCad 040–049, research 050–059, physics 060–069,
CAD 070–079.

### Research (`server/src/plugins/research/`)

**Ingest** (`POST /api/plugins/research/ingest { path, project?, privacy?,
storageDir? }` → 202 job, polled at `GET /api/plugins/research/jobs/:id`;
`GET /api/plugins/research/status` says whether pdftotext is installed).
`path` is an absolute path to Zotero's `zotero.sqlite` (copied, then opened
read-only with `node:sqlite`, so Zotero's lock never matters; attachments are
read from the `storage/` folder beside it unless `storageDir` says otherwise)
or a Better BibTeX JSON export. Items become `paper` nodes, notes `note`
nodes (`part_of` their paper), PDF pages `excerpt` nodes `part_of` their
paper (text from `pdftotext`, run with `execFile`, a fixed argument list, a
time limit and an output cap; chunked within a page, never across one), and
`dc:relation` / `cito:cites` relations `cites` edges. Source `zotero`,
`project` default `zotero`, privacy default `local` (the user may choose
`cloud`), external ids `<project>/item/<key>`, `<project>/note/<key>`,
`<project>/item/<key>/pdf/<attachment>/p<page>c<chunk>`. Migration 050 adds
`research_items` (one row per paper, note or excerpt node: citekey, DOI,
title, authors, year, attachments; an excerpt's page and exact text), which
citations and quotations are checked against. Ingesting again updates in
place and removes what the library no longer holds; without pdftotext papers
and notes still ingest and any page text from an earlier ingest is kept.

| Capability | Permission | Tags | What it does |
|---|---|---|---|
| `research.sweep` | `read_graph` (source `zotero`) | `research` | Ranked papers for a question, each with the excerpts (page, text) that make it relevant. Lexical and deterministic. |
| `research.extract` | `read_graph` (source `zotero`) | `research` | An extraction table: for given columns, one row per paper; a cell is kept only with the excerpt, page and a quote that is verbatim in that excerpt, otherwise it is empty and marked unsupported. The model only reads. |
| `research.related_work` | `read_graph` (source `zotero`) | `research` | A related-work paragraph drafted through `ctx.model` from excerpts only, citing `[@citekey]` and quoting `"…" [@citekey, p. N]`. |
| `research.web_search` | `web` | `research`, `web` | Web search through a provider-neutral interface (`{ name, search({ query, maxResults, signal }) }`); a SearXNG adapter is chosen by `SEARXNG_URL`. With no provider it refuses (`web_search_unavailable`); offline it refuses (`offline`). |

The first three run the verifiers `research.citations_resolve` (every citekey
and DOI in the output and its artifacts resolves to a paper the agent may
read; a draft may cite only the papers whose excerpts it was given, and must
cite something) and `research.quotes_match` (every quotation, structured or
in the text, appears verbatim after whitespace and typographic folding in
the excerpt or page it cites; elisions `...` match in order; a quotation
without a citation must come from a paper the result cites). A paper with no
stored page text is checked against its PDF with pdftotext; without the tool
that quotation is reported `unavailable`, never passed.

A capability that sends library text to `ctx.model` (extract, related work)
refuses with `private_sources` when any of that text is `local` and the
agent could reach the cloud (online, and `cloud_model` not denied for it),
because the model router decides by the step's slice, not by what the
capability read.

### Physics

The physics plug-in (`server/src/plugins/physics/`, tag `physics`) needs no
migration of its own: it uses 039's `derivation` and `computation` types,
source `physics`, and the existing `spec` type for ingested problems.

| Capability | Permission | Verifiers | What it does |
|---|---|---|---|
| `physics.derive` | `write_notes` | `physics.units`, `physics.limits` | Asks `ctx.model` for a derivation as JSON (result expression and units, variables with representative values and units, explicit assumptions, steps, at least one limiting case), with one repair request if the reply does not validate. Written as a `derivation` node, `derived_from` the problem node when given `problemId`. |
| `physics.compute` | `run_generated_code` | `physics.units`, `physics.rederive` | Runs model-written Python (or the `expression` template: the derivation's closed form) on Pint quantities, and a required `crossCheck` by a different method, each in its own OS-sandboxed process. Written as a `computation` node `derived_from` its derivation. |
| `physics.check` | `run_generated_code` | — | Runs the checks again on a stored derivation or computation and reports them as a finding. |

- **Verifiers.** `physics.units` evaluates the result with Pint quantities:
  adding unlike dimensions, a dimensioned argument to `sin`/`exp`/…, or a
  result whose dimensions differ from its declared units fails; for a
  computation, every output must convert to its declared units.
  `physics.limits` evaluates each declared limiting case (variables set near
  the limit) against its expected expression or value within `rtol`/`atol`.
  `physics.rederive` compares the computation with its independent
  cross-check within `tolerance` (default 1e-3, at most 0.05).
- **Expressions** are parsed with Python's `ast` and evaluated by a
  whitelist (numbers, declared variables, `pi`, `e`, `+ - * / **`, a fixed
  list of functions); anything else is refused before evaluation.
- **Everything Python runs through `runSandboxed`** (`python3 -I -B` and a
  fixed harness, `harness.py`, copied with the job into a fresh directory in
  the run's scratch space, the only writable path; thread counts pinned to 1).
  `PHYSICS_PYTHON` may name another interpreter (a virtual environment); its
  prefix is mounted read-only. Availability is probed by running the harness
  in the sandbox. Model-written code runs in a `run` job whose result says
  only which plain values (number and unit string) the code reports: the code
  shares that process and could print a result line of its own, so no check
  outcome is taken from it. The units check (conversion to the declared
  units, finiteness) and the conversion the cross-check comparison uses run
  in a separate `convert` job that runs no model-written code. The job file
  holding a run's nonce is deleted before the job starts. Without the sandbox, `python3`, NumPy, SciPy or Pint the
  verifiers return `{ ok: true, unavailable: true, detail }`,
  `physics.compute` refuses with `physics_unavailable`, and a derivation is
  written marked "unverified".
- **Write-back.** The runner's write-back makes only findings, decisions,
  questions and artifacts, so these capabilities write their own node. To
  keep "nothing is written before it is verified", the capability runs the
  checks first and writes the node only when they pass (or are unavailable);
  the verifiers report those results for that result object, or run the
  checks themselves for a result they did not see made. The node is keyed by
  step (`external_id` `derivation:<stepId>`), so a resumed step updates it.
  Each capability also returns a finding naming the node, so the next step's
  slice carries its id.
- **Privacy.** `ctx` does not say whether the step's slice held a private
  node, so physics nodes are written `local` unless `ctx.privateContext ===
  false` and every node they were built on is `cloud`. For the same reason
  `physics.derive` sends a `problemId` node's text to the model only when that
  node is `cloud` or `ctx.privateContext === true`.
- **Ingest.** `POST /api/plugins/physics/ingest { project, problems: [{ id,
  title?, statement, given?, find? }], privacy? }` (a background job, like
  GitHub ingest; privacy defaults to `local`) writes `spec` nodes with
  `external_id` `problem:<id>`, never an answer. `GET /status` reports whether
  the toolchain is usable, and `GET /jobs/:id` a physics job.

### The CAD plug-in

`server/src/plugins/cad/` (tag `cad`; migration 039's `part`, `assembly`,
`contains` and source `cad`; no migration of its own). Open formats first:
STL (ASCII and binary) and STEP's product structure are read in
JavaScript; anything that needs a B-rep kernel goes to CadQuery.

| Capability | Permission | What it does |
|---|---|---|
| `cad.inspect` | `read_graph` (source `cad`) | STL: bounding box, area, volume (signed tetrahedra), centroid, watertightness (every edge shared by exactly two faces, wound consistently), optional cross-section with holes, their spacing and wall. STEP: header, products, assemblies and what they contain, length unit; geometry from CadQuery when available, else `geometry.unavailable`. |
| `cad.mass_properties` | `read_graph` (source `cad`) | Volume, mass, centre of mass and inertia about it, for a density `{ value, unit }` (or the project's); SI results. STL in JavaScript (refused if not watertight), STEP with CadQuery. |
| `cad.interference` | `read_graph` (source `cad`) | STL pairs in JavaScript: bounding-box prefilter, a grid over the overlap, exact triangle-triangle test; touching is not interference, crossing or nesting is. STEP with CadQuery booleans (common volume), within one file or across files; a mix tessellates the STEP. |
| `cad.parametric_edit` | `run_generated_code` | Runs a CadQuery script that assigns `result`, exports it (STEP or STL by extension) into the run's sandbox copy (or its scratch directory when there is no copy), never the user's checkout. Verifiers `cad.valid_geometry`, `cad.dimensions`, `cad.no_interference`. |

The project declares in `cad.json` (all optional): `units` (what STL
coordinates mean; default `mm`), a default `density`, an `assembly` (parts
that must not interfere) and `dimensions` (checks `cad.dimensions`
applies: `{ file, measure, value, tolerance }` or `{ file, measure, min,
max }`, measures `size.x|y|z`, `volume`, `surfaceArea`, `holes.count`,
`holes.spacing`, `holes.maxSpacing`, `holes.diameter`, `holes.maxDiameter`,
`holes.minWall`).

CadQuery runs only inside the OS sandbox (`runSandboxed`): each call copies
its inputs, a driver (`driver.py`) and a request into a fresh scratch
directory, runs `CADQUERY_PYTHON -I driver.py request.json` there (no
network, only that directory writable) and removes it. `CADQUERY_PYTHON`
names an interpreter that can import cadquery, best a venv made with
`python3 -m venv --copies` so interpreter and packages share one prefix the
sandbox mounts; it defaults to `python3`. On macOS, CadQuery's wheels
(`pip install cadquery`, arm64 and x86_64) run under `sandbox-exec` the same
way; FreeCAD is not needed. Without an OS sandbox or without CadQuery,
`cadquery.status()` says why, a capability that needs it refuses with
`tool_unavailable`, and a verifier that needs it returns `{ ok: true,
unavailable: true, detail: 'unavailable: …' }` (the contract's convention:
the step is not failed for a check that could not run, and the recorded
detail says it was not made). Verifiers never trust the step's own report:
they read the produced file again, measure STL in JavaScript, and run STEP
checks in a fresh CadQuery process with no model-written code in it.

Ingest: `POST /api/plugins/cad/ingest { project, privacy? }` (a background
job, `GET /api/plugins/cad/jobs/:id`) walks the project's local folder
(never following links, hidden folders or `node_modules`). Each STL is a
`part`; each STEP product an `assembly` or `part`, with `contains` edges
weighted by quantity. External ids are `<project>|<path>[#<product id>]`,
so re-ingest updates in place; files that are gone lose their nodes, files
that fail to read keep theirs. Nodes are `local` unless the request says
`cloud`. `GET /api/plugins/cad/status` reports whether CadQuery can run.

A SolidWorks companion is designed, not built: `solidworks-connector.md`.

### KiCad (`server/src/plugins/kicad/`)

Reads KiCad 6+ `.kicad_sch` and `.kicad_pcb` files with its own small
S-expression reader. Net resolution is pragmatic: wires join at their ends
and at any connection point on them (crossing wires only through a
junction), pins at one point join, power ports, global labels and hidden
power-input pins join by name across the design, local labels by name on one
sheet, and sheet pins join the child's hierarchical labels. Buses are not
followed. Net names follow KiCad (`/LED_A` for a root-sheet local label,
`Net-(R1-Pad2)` when nothing names a net). Points are indexed by row and
column before they are matched to wires, and a design with more than 500,000
connection points, or whose wires would need more than 5,000,000
point-on-wire tests, is refused with `design_too_large`.

Ingest: `POST /api/plugins/kicad/ingest { project, privacy? }` reads the
folder bound to the project (`project_settings.local_path`) as a background
job (`GET /api/plugins/kicad/jobs/:id`); privacy defaults to `local`. Each
root schematic gives a `schematic` node with `symbol`, `net` and `bom_row`
nodes `part_of` it; each board a `board` node with `footprint` and `net`
nodes. Schematic nets `connect` symbols, board nets `connect` footprints, and
a footprint `implements` its symbol (by the symbol path the footprint
records, else by reference). External ids are
`<project>|<kind>|<file>[|<name>]`; re-ingest updates in place, removes what
is gone and rebuilds these links in one transaction, leaving links from other
nodes (an agent's notes) alone. A file that fails to load keeps the nodes of
its last good ingest (it is listed in the summary's `errors`), and nothing is
pruned when the folder scan was truncated. `GET /api/plugins/kicad/status` says whether
kicad-cli can run ERC and DRC.

| Capability | Permission | Tags | Does |
|---|---|---|---|
| `kicad.net_query` | `read_graph` (source `kicad`) | `kicad` | pins and symbols on a net, or the nets a symbol touches |
| `kicad.footprint_query` | `read_graph` (source `kicad`) | `kicad` | footprints by reference, value, layer or net, with placement and pad nets |
| `kicad.bom` | `read_graph` (source `kicad`) | `kicad` | the BOM as a table, and a CSV artifact |
| `kicad.schematic_review` | `read_graph` (source `kicad`) | `kicad` | unconnected pins, missing values and footprints, power nets with an IC pin and no capacitor to ground; findings per issue |

Capabilities read the run's sandbox copy when there is one, else the project
folder, and return the ingested nodes they are about as `touchedNodeIds`.
The review finds every issue in code; `ctx.model` may only reword them, a
reworded issue is kept only if it still names its part or net, and for a
private design the model is asked only when the call cannot leave the
machine (`ctx.model.offline`, or the agent's policy is `local_only`).

Verifiers `kicad.erc` and `kicad.drc` run `kicad-cli sch erc` / `pcb drc`
(KiCad 8+, JSON report) on a copy of the design's files in a scratch
directory inside the OS sandbox, never on the host, and pass when the report
has no error-severity violation. Without kicad-cli 8+ they return `{ ok:
true, unavailable: true }`; without an OS sandbox `{ ok: false, unverified:
true }`. They check at most 10 designs per step; when more exist, or the
folder scan was truncated, a clean result is `{ ok: false, unverified: true }`
with the number skipped, never a pass. They are for capabilities that change a design; the four read-only
capabilities above carry none, since a design that fails ERC must not fail a
read of it.
