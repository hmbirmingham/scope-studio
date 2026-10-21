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
| `budget` | Per-run limits `{ maxTokens, maxUsd, maxWallMs }`. A run stops with `budget_exceeded` at the first limit it crosses. |
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

1. **Hard denials** that no level or override can lift:
   - the agent is `killed` or `paused`;
   - the capability is unknown;
   - `run_generated_code` outside the sandbox (`context.inSandbox !== true`);
   - `read_graph` on a project or source outside the read scope;
   - `write_notes`, `edit_files`, `open_pr`, `apply_merge` on a project outside the write scope;
   - `web` or `cloud_model` while offline (`context.online === false`);
   - `cloud_model` with `modelPolicy: 'local_only'`, or when the step's context
     holds a private node (`context.privateContext === true`).
2. **The agent's override** for that capability, if any.
3. **The level default** from the table above.

`ask` creates an approval; the step waits until the user approves or rejects it.

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
      async run(input, ctx) { … },  // returns { output, touchedNodeIds?, artifacts? }
    },
  ],
  verifiers: [
    { name: 'code.tests', tags: ['code'], async verify(result, ctx) { … } }, // → { ok, detail }
  ],
};
```

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
then `port.stream`; it never branches on which adapter it got.

### Activity event stream

`GET /api/workspace/events?runId=…` is Server-Sent Events. Each event:

```
id: <seq>
event: <type>
data: {"v":1,"seq":<seq>,"runId":"…","agentId":"…","at":"<ISO time>","type":"<type>","data":{…}}
```

`seq` increases per run, so a client reconnecting with `Last-Event-ID` gets
what it missed. Types: `run.queued`, `run.started`, `run.paused`,
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
`ON DELETE CASCADE`, so deleting a user removes their agents and runs, and
the test helper's truncate of `users` clears them.

`agent_runs` is the durable queue: a worker claims the oldest `queued` run
with `FOR UPDATE SKIP LOCKED` and holds a lease (`lease_owner`,
`lease_until`); a run whose lease expired is reclaimed after a crash.

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
