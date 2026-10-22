# Student demo

A five-minute demo of the agent workspace for a university student, on a Mac,
on the free local setup: Ollama models on the laptop, no account, no API key,
nothing paid. One command starts it with a seeded intro-physics project.

## Set up the Mac (once)

You need Homebrew (https://brew.sh). Then, in Terminal:

```sh
brew install node postgresql@18 pgvector ollama
brew services start postgresql@18
brew services start ollama          # or open the Ollama app instead
ollama pull nomic-embed-text        # 274 MB, the embedding model
ollama pull qwen3:8b                # 5.2 GB, the local chat model (see "Which model")
```

Then get the code and install it:

```sh
git clone https://github.com/hmbirmingham/scope-studio.git
cd scope-studio
git checkout feat/student-demo      # until it is merged
```

`npm run demo` installs the engine's and the app's packages itself the first
time (you will see npm's progress), so there is nothing else to install.

## Run it

```sh
npm run demo
```

It checks everything it needs and says exactly what to run if something is
missing (it never downloads a model on its own), then:

1. creates and migrates a `scope_demo` database (its own database, so your
   other data is never touched);
2. seeds the student project, the agent and its tasks. Running it again resets
   the demo account's data, so every demo starts the same;
3. starts the engine on 127.0.0.1 only, signed out (free, local answers only),
   with agent networking off;
4. builds and serves the app, opens http://localhost:5173 in your browser and
   loads the chat model into memory.

Ctrl-C stops everything. Options: `DEMO_DATABASE_URL` (default
`postgresql://localhost:5432/scope_demo`), `DEMO_ENGINE_PORT` (3001),
`DEMO_CLIENT_PORT` (5173), `OLLAMA_CHAT_MODEL` (qwen3:8b), `--no-open`.

The app opens straight onto the map: in this local mode the engine signs the
browser on the same machine in to the demo account, so there is no sign-in
screen. Local mode only ever signs in to the demo account
(`student@scope-demo.local`), only with `NODE_ENV=development`, only on an
engine listening on loopback (the engine refuses to start otherwise), and only
for a request from this machine's own browser on `localhost`. Never put
`SCOPE_LOCAL_USER` in a `.env` file or expose the app with `vite --host`.

### Which model

The agent runs on whatever `OLLAMA_CHAT_MODEL` names; the default is
`qwen3:8b`.

- **Apple silicon with 16 GB or more: `qwen3:8b`** (the default). It is the
  model the engine is tuned for, and on an M-series GPU a planning call (about
  1.9k tokens in, 300 out) takes on the order of 15 to 25 seconds, so the
  whole lab check runs in roughly a minute plus the time you spend on the
  approval. This is an estimate from typical M-series throughput for an 8B
  model at Q4, not a measurement; time one run before the demo.
- **8 GB Macs: `qwen3:4b`** (`ollama pull qwen3:4b`, then
  `OLLAMA_CHAT_MODEL=qwen3:4b npm run demo`). Half the memory and roughly
  twice as fast. Smaller models keep to the strict step format less
  reliably, so do one full run with it before the demo.

Measured with `qwen3:8b` on the machine this was built on (a 4-core cloud VM,
CPU only, no GPU), one full *Check my lab report against the data* run with
every vertical registered, approved straight away:

| Step | Time |
|---|---|
| Plan | 1 min 26 s |
| Run code in the sandbox (writing the code; running it took under 0.1 s) | 4 min 7 s |
| Save to the map | 2 min 5 s |
| Wrap-up | 1 min 3 s |
| **Whole run** | **8 min 37 s**, 9,109 tokens, $0 |

The code it wrote computed slope 4.035 s²/m, g = 9.783 m/s² and 1.794 s at
0.80 m, the same as the reference analysis. Its list of fixes caught the slope,
g, the uncertainty and that the 0.80 m point belongs in the fit, but did not
say the report's 0.80 m row was copied from the 0.60 m one, so know the
answers in step 6 of the talk track. Six real runs went into preparing this:
earlier task wordings led the model to put code in its plan, to run past
the step's output limit, and to re-run the code after saving, and offering it
the physics capabilities sent it into three failed `physics.check` steps. The
current task and agent completed cleanly in both runs made with them (11 min
and 8 min 37 s here). A CPU without a GPU is this slow: run
the demo on Apple silicon, and do one full run beforehand so the model is
warm and you have seen its output.

## What is in the demo

**PHYS 101 Pendulum Lab**, one week of a first-year physics course:

| Node | What it is |
|---|---|
| Lab report draft | Measuring g with a simple pendulum, due Friday. It has real mistakes: the 0.80 m row is copied from the 0.60 m row, the slope is misread (g = 9.62 m/s²), the uncertainty is only the stopwatch's resolution, and the discussion claims more than the data show. |
| Raw data: pendulum-data.csv | 5 lengths × 3 trials. A least-squares fit gives g = 9.78 ± 0.04 m/s². |
| Lab 3 handout | The instructions and the marking rubric. |
| Lecture 7 and 8 notes | Simple harmonic motion; pendulums and the small-angle approximation. |
| Problem set 4 | Oscillations. |
| Nelson & Olsson (1986), Taylor (1997) | The two references the report should cite. |
| **Private: my study log and grades** | Marked *local only* (■ in the sidebar). It never leaves the laptop, and neither does anything an agent learns from it. |

**Lab Partner**, an agent made from the built-in Physicist role: Supervised
(it reads the map and writes notes freely, and asks before anything else),
Local only (every model call goes to Ollama on this machine), allowed to read
and write only this project. Its capability tags are the Physicist's without
`physics`: it can run code in the sandbox and save to the map, and nothing
else. The physics plug-in's capabilities need Python with NumPy, SciPy and
Pint in the sandbox, and a real 8B model offered them spent three failed steps
on `physics.check` before going back to the task. To show them, install that
toolchain and tick **physics** under Capability tags in the agent's **Edit**
dialog; rehearse it first.

**Tasks**: *Check my lab report against the data* and *Make a study guide
from my lecture notes* (one-off), and *Weekly study guide* (Sundays 18:00
UTC) to show scheduling.

## Talk track (5 minutes)

Before they arrive: `npm run demo`, wait for "qwen3:8b is loaded and ready",
leave the browser on the map. Close other heavy apps.

1. **The map (30 s).** "This is everything for one course: the lab report
   I'm writing, the raw data, the handout, lecture notes, a problem set and two
   papers, all linked. It's a knowledge graph, and it lives on this laptop."
   Point at the ■ next to *PHYS 101 Pendulum Lab*: "One note, my study log
   with my grades, is marked local only. Nothing from it ever goes to a cloud
   model, and anything an agent learns from it is private too."
   Hover a node to show its type and size.

2. **The agent (45 s).** Click **Agents**. "Lab Partner is an agent I made from
   the Physicist template. It's *supervised*: it can read my notes and write
   notes back, and it has to ask me before it does anything else, like running
   code. *Local only*: it runs on a model on this laptop, so it's free, it
   works offline, and no account or API key is needed." Point at the tasks:
   "Two jobs I gave it, and a weekly one: every Sunday it updates my study
   guide by itself."

3. **Start the task (30 s).** Click **Run now** on *Check my lab report against
   the data*. The **Activity** tab opens on the run. "It's going to recompute g
   from my data and check the report against it and the rubric." Point at the
   meters: tokens, cost (it stays at $0.000), time.

4. **Watch it work (60 s).** The **Plan** step fills in. "It plans first, and
   writes the plan into the map, not into a chat transcript. Every step reads
   a small, fixed-size slice of the map, so step 20 costs the same as step 2,
   which is why a laptop model can do long tasks." Each note it writes lights
   up on the map on the right in the agent's colour.

5. **The approval (45 s).** The next step stops at **Waiting for approval**:
   *Run code in the sandbox*. The Approvals tab shows a badge. Open **Read the
   code before it runs**: "It wrote a least-squares fit with my 15 data points
   in it. It can't run anything without me, and when I approve it runs in a
   sandbox with no network and no access to my files." Click **Approve**.

6. **The result (60 s).** The step prints what the code computed: a slope of
   about 4.03 s²/m, g ≈ 9.78 m/s², and a mean period of about 1.79 s at 0.80 m
   (the report says 1.556 s). Then *Save to the map* and the run
   **Succeeded**. Under **Findings and artifacts** click **Read** on the list of
   fixes: "My 0.80 m row was copied from the 0.60 m one, that's why I thought
   it was an outlier and got 9.62." The correct answers, if the model's list
   misses one: the uncertainty should come from the spread of the trials
   (about ±0.04 m/s², not ±0.01), and the data can't show the period is
   independent of amplitude at any angle, since every trial was at about 10°.

7. **It's in the map (30 s).** Click the artifact's name: the map flies to the
   new node, and the inspector shows what it was derived from: the report, the
   data, the handout, the plan and the analysis step. "Next week, when I ask
   about this lab, this is already here." If the private study log was in what
   it read, the artifact shows *local only* too.

If there is time: run *Make a study guide from my lecture notes*. Writing a
note is allowed, so it runs straight through with no approval.

Expect the model's wording, its exact plan and the number of steps to vary
from run to run; the numbers the code step prints are computed, not written by
the model. A local model sometimes takes an extra step or a failed one (marked
Failed with the reason, e.g. `chooser_not_json` when its reply was cut off),
and the next step reads that failure from the map and tries again; five
failures in a row stop the run. If that happens on stage, say so: it is the
safety net working. Then run the task again.

If, after *Save to the map*, it asks to run the code a second time (an 8B
model sometimes loses track of the last step), click **Reject**: the
rejection is written to the map and the next step usually finishes. If it
keeps going, click **Stop run**; the list of fixes is already saved.

## Why switch (what can honestly be said)

- **Free, and local.** Everything above ran on the laptop, on an open model
  through Ollama. No account, no subscription, no API key; the run's cost
  meter stayed at $0.000. It keeps working offline.
- **Private notes stay private.** A node marked local only is never sent to a
  cloud model, and anything derived from it inherits that mark, so it can't
  leak later either (`inheritPrivacy`, docs/architecture/agent-workspace.md).
- **Your own Anthropic key: optional, and not part of this demo.** Nothing
  shown here needs a key or an account. Using your own key for the hard
  questions is a paid-plan feature today, not part of the free setup; the key
  travels with each request and is never stored by the engine. Launch pricing
  is being reworked, so don't promise anything about it.
- **Agents that ask.** Every action goes through one permission check. A
  supervised agent asks before running code, editing files or using the
  network, and model-written code only ever runs in an OS sandbox.
- **Small context per step, from the graph.** The task benchmark
  (`npm run benchmark:tasks`, a dry run with scripted models, re-run for this
  document; six code tasks, one research task and one physics task, every arm
  completes 8/8; the CAD and KiCad tasks are listed but not run here):

  | Arm | Cost per completed task |
  |---|---|
  | Scope, local model | $0 |
  | Scope, local + cloud planner | $0.0026 |
  | Standard full-transcript agent, Claude Sonnet | $0.0117 |
  | Standard full-transcript agent, Claude Opus | $0.0292 |

  On the longest task Scope's per-step context levels off at about 1.8k
  tokens, while the full-transcript agent's grows every turn to 4.3k. The dry
  run measures the harness and the economics with scripted models, not model
  quality; on short tasks the two context curves differ little, and the
  saving comes mostly from where the tokens run (locally, at $0).

Say "free on your laptop" and stop there: launch pricing, including what the
own-key option will cost, is being reworked, so don't quote plans or prices.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Postgres is not running at localhost:5432` | `brew services start postgresql@18`. Check with `brew services list`. |
| `refused the login` / `role "…" does not exist` | Homebrew's Postgres trusts your macOS user. If you run it differently: `DEMO_DATABASE_URL=postgresql://<user>@localhost:5432/scope_demo npm run demo`. |
| `the pgvector extension is not installed` | `brew install pgvector && brew services restart postgresql@18`. If the formula does not support Postgres 18 yet, build it: `git clone --branch v0.8.1 https://github.com/pgvector/pgvector.git && cd pgvector && make PG_CONFIG=$(brew --prefix postgresql@18)/bin/pg_config && make install PG_CONFIG=$(brew --prefix postgresql@18)/bin/pg_config` |
| `Ollama is not running` | Open the Ollama app, or `brew services start ollama`. |
| `… is not pulled yet` | Run the `ollama pull …` line it prints. |
| `Port 3001 is already in use` | Another Scope Studio or dev server: stop it (`lsof -i :3001`), or `DEMO_ENGINE_PORT=3002 npm run demo` (and `DEMO_CLIENT_PORT` for 5173). |
| `Node … is too old` | `brew upgrade node`, then open a new terminal. |
| The run sits on its first step for minutes | The model is slow on this machine (no GPU) or still loading. Wait for "loaded and ready" before starting; on 8 GB, use `qwen3:4b`. |
| A step fails with `chooser_not_json` or `invalid_input` | The model's reply was not a valid step; the run records it and tries again (it stops after five failures in a row). Use the default model, or run the task again. |
| `sandbox_unavailable` on the code step | The OS sandbox is missing: on macOS `/usr/bin/sandbox-exec` must exist (it ships with macOS). The rest of the demo still works. |
| The app shows a sign-in form | The page is not being served by `npm run demo` (local mode is off), or it was opened by a name other than `localhost` / `127.0.0.1`. Use the URL the launcher prints. |
| Start over | Ctrl-C and `npm run demo` again: the demo data is reset each time. |
