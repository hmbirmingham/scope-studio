# Scope Studio

An engineering workspace that keeps your projects in a knowledge graph on your
own machine, answers questions about them with the minimum context that
answers them, and runs agents that do long engineering, research and code
tasks one small, verified step at a time. Built for engineers and STEM
researchers who work across several tools, codebases and projects.

**Studio:** Fourier Studios
**Status:** pre-launch; the local experience runs end to end (see the quick start)

It runs locally first: the map, retrieval, the local model (Ollama), agents,
the sandbox and every plug-in live on your laptop, and work keeps going
offline. Notes you mark *local only* never leave the machine, and neither does
anything an agent learns from them. The cloud is optional and is used only for
the questions and agent steps that need it.

## Quick start (macOS, local and free)

You need [Homebrew](https://brew.sh). Five commands:

```sh
brew install node postgresql@18 pgvector ollama
brew services start postgresql@18 && brew services start ollama && sleep 5
ollama pull nomic-embed-text && ollama pull qwen3:8b
git clone https://github.com/hmbirmingham/scope-studio.git && cd scope-studio && git checkout dev
npm run demo
```

`npm run demo` checks what it needs (and prints the exact command for anything
missing), creates its own `scope_demo` database, seeds a first-year physics
project with an agent and its tasks, starts the engine and the app, and opens
http://localhost:5173. No account, no API key, nothing paid. If `ollama pull`
says it cannot connect, the Ollama service is still starting: wait a few
seconds and run that line again. On an 8 GB Mac use
`qwen3:4b` instead of `qwen3:8b` (`OLLAMA_CHAT_MODEL=qwen3:4b npm run demo`).
[docs/demo.md](docs/demo.md) has the details, a five-minute talk track and
troubleshooting.

## Features

- **The map.** A directed, weighted knowledge graph of your engineering
  artifacts and how they relate (`depends_on`, `supersedes`, `caused_by`,
  `part_of`, …), not a flat vector store.
- **Token-efficient answers.** Hybrid dense + lexical retrieval with graph
  expansion packs the smallest connected slice that answers a question
  (1,500 tokens locally), measured on a 20-query benchmark
  ([ARCHITECTURE.md §3–§8](ARCHITECTURE.md)).
- **Routing.** Questions are answered by a local model through Ollama
  (`qwen3:8b` by default); private context always stays local, and the cloud
  (Anthropic) is used only where the plan and the question allow it.
- **Agents.** Agents you build from role templates (Researcher, Builder,
  Debugger, Physicist, Hardware Engineer, CAD Designer), each with a
  permission level, scopes, a model policy and a budget. Tasks run once or on
  a cron schedule, through a durable queue that survives restarts. Each step
  reads a fixed-size slice of the map, so a laptop model can run long tasks.
- **Permissions and approvals.** One permission check decides every action;
  anything an agent is not trusted to do on its own waits in an approvals
  inbox. A kill switch stops an agent and its runs at once.
- **OS sandbox.** Model-written code and external tools run only in
  bubblewrap (Linux) or sandbox-exec (macOS), with no network, on a private
  copy of the project.
- **Live activity.** Every step, approval, cost and node written streams to
  the Activity tab and lights up on the map.
- **Verticals**, as plug-ins every role with the right tag can use:
  - **Code**: search, read, edit in the sandbox copy, run declared scripts,
    run model-written code; typecheck, lint, build and test verifiers.
  - **Research**: Zotero and Better BibTeX ingest with PDF text; literature
    sweep, extraction tables and related-work drafts whose citations and
    quotations are checked against the library; optional web search.
  - **Physics**: derivations with unit and limiting-case checks, and
    computations on Pint quantities with an independent cross-check.
  - **CAD**: STL and STEP inspection, mass properties, interference checks,
    and CadQuery parametric edits.
  - **KiCad**: schematic and board ingest, net and footprint queries, BOM,
    schematic review, ERC and DRC through `kicad-cli`.
  - **GitHub**: repository ingest into the map.
- **Task benchmark.** Whole tasks, objectively checked, run through Scope and
  through a standard full-transcript agent, to measure what the graph-as-memory
  design saves.

Using the cloud on your own Anthropic key, and paid cloud, depend on the plan.
Launch pricing is decided in outline; details and implementation are pending.
The design note is in the doc map below.

## Doc map

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The decisions and why: the map, retrieval and scoring, routing, plans, the retrieval benchmark, and the agent workspace (§9). |
| [docs/architecture/agent-workspace.md](docs/architecture/agent-workspace.md) | The agent workspace contract: schema, `can()`, the capability registry, the runner, the sandbox, the ModelPort, events, HTTP shapes, each vertical, the task benchmark. |
| [docs/demo.md](docs/demo.md) | The local demo: Mac setup, what is seeded, a five-minute talk track, troubleshooting. |
| [docs/architecture/pricing-launch.md](docs/architecture/pricing-launch.md) | Design note (not implemented) for the launch pricing change. |
| [docs/architecture/solidworks-connector.md](docs/architecture/solidworks-connector.md) | A SolidWorks companion: designed, not built. |
| [control/README.md](control/README.md), [control/API.md](control/API.md) | The hosted control plane (accounts, plans, billing, platform cloud) and its API. |
| [docs/legal/](docs/legal/) | Terms of service and privacy policy (drafts). |

## Project structure

```
scope-studio/
├── server/    The local engine: Node + Express, Postgres + pgvector, Ollama
├── client/    The app: React + Vite
├── control/   The hosted control plane: accounts, plans, Stripe, platform cloud (Railway)
├── docs/      Architecture contracts, the demo guide, legal drafts
└── package.json   `npm run demo`
```

Each package has its own dependencies (`npm install` in `server/`, `client/`
and `control/`). For development outside the demo, copy `.env.example` to
`.env` (and `control/.env.example` to `control/.env`) and fill in the values
each one describes; nothing has a default secret.

## Running the tests

Every suite runs offline: Anthropic, Stripe, GitHub and the control plane are
replaced by local fakes. The engine and control suites need Postgres 18 with
pgvector; the engine's also needs Ollama with `nomic-embed-text`, and uses
bubblewrap (Linux) or sandbox-exec (macOS) for the sandbox tests. Create the
test databases first (the suites migrate them; the engine's suite also creates
`scope_studio_test_control` for the control plane it runs, on first use):

```sh
createdb scope_studio_test && createdb scope_control_test && createdb scope_demo_test
# From the repository root. Engine (it runs the control plane in-process,
# so control/ is installed first):
cd control && npm install && cd ../server && npm install
NODE_ENV=test TEST_DATABASE_URL=postgresql://localhost:5432/scope_studio_test \
  SESSION_SECRET="$(openssl rand -hex 32)" BASE_URL=http://localhost:3001 npm test
NODE_ENV=test DATABASE_URL=postgresql://localhost:5432/scope_studio_test \
  npm run benchmark:tasks        # the task benchmark, dry: scripted models, $0

# Control plane
cd ../control
NODE_ENV=test TEST_DATABASE_URL=postgresql://localhost:5432/scope_control_test \
  CONTROL_SESSION_SECRET="$(openssl rand -hex 32)" npm test

# App
cd ../client && npm install
npm test                         # unit tests (Vitest)
npx playwright install chromium  # once
npx playwright test              # workspace smoke test in Chromium, API mocked
DEMO_DATABASE_URL=postgresql://localhost:5432/scope_demo_test \
  npx playwright test -c playwright.demo.config.js   # the demo end to end, scripted model
```

The engine and control harnesses refuse a database whose host is not
`localhost`, `127.0.0.1` or `postgres` (the CI service name); the demo test
accepts only `localhost` or `127.0.0.1`. CI
(`.github/workflows/ci.yml`) runs all of the above, plus the optional
toolchains the verticals check against (pdftotext, NumPy / SciPy / Pint,
CadQuery).
