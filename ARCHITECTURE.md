# Scope Studio — Architecture Decision Record
**Version:** 0.4 (new §9 records the agent workspace, the capability plug-ins and verticals, the OS sandbox, the ModelPort, the engine ↔ control link, the task benchmark and the local demo; §5 points to the launch pricing design note; the former §9 and §10 are now §10 and §11. v0.3 built the retrieval benchmark, added the definition term to §4 and settled items 1 and 3 of what is now §10.)
**Author:** Hynes Birmingham, Fourier Studios
**Last updated:** October 2026
**Status:** Canonical — update only when a fundamental decision changes

This document records the core architectural decisions made during scoping,
the reasoning behind each, and the research that supports them. It is the
document a faculty reviewer, recruiter, or future collaborator reads to
understand Scope Studio without reading the codebase.

---

## 1. What Scope Studio Is

A persistent, token-efficient engineering context layer. It ingests
engineering artifacts into a knowledge graph (the "neural map"), retrieves
a minimal connected subgraph per query, injects it as context, and routes
the query to either a local 7B-class model or a cloud model.

**The core claim:** Scope Studio uses 70%+ fewer tokens to answer the same
engineering query as pasting full context manually, with no drop in answer
correctness, because it retrieves precisely what is relevant rather than
everything that exists.

The same graph is also the working memory of the **agent workspace** (§9):
user-owned agents that run long tasks one small step at a time, each step
reading a fixed-size slice of the graph, acting through one declared
capability, verifying the result and writing what it learned back as nodes.
**The second claim** follows from the first: because a step's context does
not grow with the task, a local 8B model can run long engineering, research
and code tasks, and the cloud is kept for the few steps that need it.

---

## 2. The Neural Map

### 2.1 Why a graph over a flat vector database

A flat vector database returns the top-N semantically similar chunks. For
engineering work this is insufficient: a query about a firmware bug needs
not just the file with the bug but the schematic it depends on, the design
decision that motivated the architecture, and the test log that first
surfaced the failure. These relationships are structural, not semantic.

A directed weighted knowledge graph allows retrieval to follow relationship
types (depends_on, caused_by, supersedes, part_of, references) from seed
nodes, surfacing context that would score low on semantic similarity alone
but is essential for correct answers.

### 2.2 Node schema

```javascript
{
  id: uuid,
  type: 'repo' | 'file' | 'decision' | 'spec' | 'paper' | 'datasheet' | 'conversation',
  content: string,
  embedding: vector(768),           // nomic-embed-text
  token_length: integer,            // computed at ingestion, O(1) packing
  source: 'github' | 'notion' | 'kicad' | 'overleaf' | 'zotero' | 'manual',
  project: string,
  created_at: timestamp,
  last_accessed: timestamp,
  last_confirmed_useful: timestamp, // user-confirmed retrieval (breaks feedback loop)
  access_count: integer,
  confirmed_useful_count: integer,  // separate from access_count
  privacy: 'local' | 'cloud'
}
```

The type and source lists above are the original schema. Later migrations
widened both: migration 020 adds the agent write-back types (`plan`, `step`,
`finding`, `artifact`, `question`; `decision` already existed), source
`agent` and the relationships `derived_from`, `produces`, `follows`,
`answers`; migration 039 adds the verticals' vocabulary (KiCad `schematic`,
`board`, `symbol`, `net`, `footprint`, `bom_row`; research `note`,
`excerpt`; physics `derivation`, `computation`; CAD `part`, `assembly`),
the sources `pdf`, `physics`, `cad` and the relationships `connects`,
`implements`, `cites`, `contains`. The full lists are in
[docs/architecture/agent-workspace.md](docs/architecture/agent-workspace.md)
("Graph write-back", "Verticals").

**Key design decision — `token_length` at ingestion:**
Token length is computed once when a node is ingested, not at retrieval
time. This allows the greedy packing step to use integer summation
(`SUM(token_length) <= 1500`) instead of a tokenizer call, keeping
retrieval overhead well under the 300ms budget.

**Key design decision — `last_confirmed_useful` and `confirmed_useful_count`:**
Standard `access_count` and `last_accessed` create a rich-get-richer
feedback loop: nodes retrieved frequently get boosted, which causes them
to be retrieved more. Breaking this requires counting only user-confirmed
useful retrievals (explicit thumbs-up, accepted suggestion, or no
follow-up re-ask within 60 seconds) rather than every retrieval.

### 2.3 Relationship types and their retrieval semantics

| Relationship | Direction | Retrieval behavior |
|-------------|-----------|-------------------|
| depends_on | A → B | Forward: retrieve B when querying A (change impact) |
| references | A → B | Forward: soft boost to B when A is a seed |
| supersedes | A → B | A supersedes B: B is DEMOTED, not promoted |
| caused_by | A → B | Reverse: retrieve B for "why" questions about A |
| part_of | A → B | Hierarchy: B (parent) gets soft boost when A is a seed |

**Critical decision — supersedes as demotion:**
The v0 pipeline treats supersedes like any other edge, allowing stale
decisions and old spec revisions to outrank current ones. The correct
behavior: when node A supersedes node B, B receives a score multiplier
of 0.1 (near-zero, not zero, to preserve it as context if nothing else
is available). This is implemented in the graph expansion step, not
the relevance floor.

---

## 3. The Retrieval Pipeline

### 3.1 v0 pipeline (baseline)

1. Embed query with nomic `search_query:` prefix
2. Candidates: top-20 dense (cosine, HNSW) union top-20 lexical (tsvector,
   identifier splitting on `/ . _ -`, minimum-should-match = 2 terms)
3. Reciprocal Rank Fusion, k = 60
4. Relevance floor: cosine >= 0.55 OR lexical hit
5. Score = `rrf × (1 + recency + project + taskType)`
6. One-hop graph expansion from top-3 seeds
7. Greedy pack into 1500 tokens, max 10 nodes

### 3.2 Known weaknesses being addressed in v1

**Weakness 1 — Recency saturates in active sessions.**
The step-function (0.4 if <24h, 0.2 if <7d, else 0) stops discriminating
exactly when the user is working hardest. Every touched node in an active
session is "<24h" so the boost is uniform and useless.

**Fix:** Replace with exponential decay: `recency = e^(-λ × hours_since_access)`
where λ is node-type-specific. Fast-aging nodes (run logs, conversation):
λ = 0.15 (half-life ~5 hours). Slow-aging nodes (datasheets, specs): λ = 0.01
(half-life ~70 hours). Decision nodes: λ = 0.03 (half-life ~23 hours).

**Weakness 2 — Rich-get-richer feedback loop.**
access_count bumped on every retrieval biases toward frequently-retrieved
nodes regardless of whether they were useful.

**Fix:** Boost uses `confirmed_useful_count` not `access_count`. Log both;
only the confirmed count drives boost. Decay `confirmed_useful_count` itself
over time using the same exponential family to prevent permanent entrenchment
of early retrievals.

**Weakness 3 — Task type requires client declaration.**
Nothing infers task type from the query, so `TASK_TYPE_BOOSTS` is empty and
useless.

**Fix:** Lightweight cosine classifier against 5-7 type centroids computed
from labeled examples. Centroids are stored as vectors in PostgreSQL and the
classification is a single batch cosine query — no external service, no
additional model pass, stays within the 300ms budget. Session context
(active plugin source, recently accessed node types) provides a prior that
weights the centroid scores before the query embedding is even computed.

**Weakness 4 — CAD and structured artifacts are served poorly by prose embeddings.**
BOMs, netlists, parameter tables, and run logs have low semantic content in
prose embedding space. Their relevance is positional (current revision,
run that produced this plot) rather than semantic.

**Fix:** Per-source lexical weight multipliers. For kicad and structured
sources, the RRF fusion weight shifts toward lexical (identifier matching)
and away from dense. Revision-awareness: nodes with a supersedes relationship
pointing to them receive the 0.1 demotion multiplier. Structured nodes
(type = datasheet, source = kicad) get an additional source-type boost of
0.2 when the inferred task type is hardware-related.

**Weakness 5 — Cosine similarities cluster in narrow band (0.52-0.82).**
Additive boosts re-order across relevance tiers. Multiplicative boosts
preserve tier ordering while re-ranking within tiers.

**Decision confirmed:** Scoring formula uses multiplication throughout,
not addition: `score = rrf × (1 + Σ boosts)` where all boosts are
additive inside the parentheses but the whole expression multiplies rrf.
This preserves the relevance floor's tier separation.

---

## 4. The v1 Scoring Function

```
score(node) = rrf(node)
            × (1 + recency(node)
                 + project(node)
                 + taskType(node)
                 + sourceType(node)
                 + definition(node))
            × supersedeDemotion(node)

where:

recency(node) = e^(-λ(node.type) × hours_since_anchor)
  anchor = last_confirmed_useful, falling back to created_at until a
           confirmation exists (never last_accessed — that reopens the loop)
  λ values: conversation=0.15, file=0.08, decision=0.03, spec=0.03,
            datasheet=0.01, paper=0.01, repo=0.005

project(node) = 0.3 if node.project == active_project else 0

taskType(node) = 0.3 × confidence × [node.type ∈ TASK_NODE_TYPES[inferred_task]]
  confidence = cosine_similarity(query_embedding, centroid[inferred_task])
  inferred_task ∈ {codebase, firmware, hardware, data_pipeline, research, cross_project}
  centroid[task] = mean embedding of labeled examples for that task
  TASK_NODE_TYPES: codebase → {file, repo}; firmware → {file, datasheet};
                   hardware → {datasheet, spec}; data_pipeline → {file, repo};
                   research → {paper, decision, spec}; cross_project → {repo}
  (v0.2 had no task for the benchmark's own "codebase lookup" category; a
   migration-runner question inferred `research` on live data.)
  (v0.1 wrote this term without a node factor; it multiplied every candidate
   equally and re-ranked nothing.)

sourceType(node) = 0.2 if source ∈ {kicad} AND inferred_task == hardware
                 = 0.1 if source ∈ {zotero, overleaf} AND inferred_task == research
                 = 0 otherwise

supersedeDemotion(node) = 0.1 if any node supersedes this node
                        = 1.0 otherwise

definition(node) = 2.0 if inferred_task ∈ {codebase, firmware, data_pipeline}
                       AND the chunk defines an identifier whose every part
                       the query supplied (def/class/function/const/…, or a
                       C-style `type name(...) {`; identifiers split on `_`
                       and camelCase the way the lexical index splits them)
                 = 0 otherwise
```

**The definition term (v0.3), and why it is large.** The benchmark's own
first query, "what does `quantify_colonies` return", missed on both tiers:
the chunk holding `def quantify_colonies` had the second-highest cosine
similarity of any node but was named once, while a test file names the
function ten times. `ts_rank_cd` is frequency-weighted, so the definition
fell outside the lexical top 20, and RRF then scored it identically to a
lexical-only chunk with no dense signal at all. A boost of 1.0 did not
clear that gap; 2.0 did, and 1.5–3.0 all give the same result, so the
value is not delicate. It is gated to code-shaped tasks because a research
or decision question is rarely answered by the code that defines its terms:
ungated, it displaced a failure-analysis summary with the function that
computes the analysis.

**Tried and rejected (v0.3): a file-kind boost.** Preferring code chunks for
code questions and README chunks for research questions, from the path
extension, cut the local hit rate from 75% to 55%. Task inference is right
three times in four, and when it guesses `research` for a question the code
answers, preferring prose buries the answer. Nothing that multiplies a
75%-accurate signal across every candidate survives contact with this corpus.

**What the benchmark said about the "tune first" list.** On the live corpus,
none of the following moved hit rate, recall or MRR at all: the relevance
floor from 0.50 to 0.75, `rrf_k` from 10 to 100, `max_nodes` from 3 to 12,
and every rung of the ablation ladder (recency, task inference, supersede
demotion). The reasons are structural, not tuning: every node was ingested
on the same day (recency is flat), there are no decision nodes (demotion
has nothing to act on), and the task-type boost applies to `file`, which
is every chunk. These become live signals only once the corpus carries
decisions, confirmations, and age. The one parameter that moved anything
was the local token budget: 800 → 1,500 tokens raised hit rate from 55% to
70%; beyond 1,500 nothing changed because `max_nodes` and ~750-token chunks
cap the pack at two or three chunks either way.

---

## 5. Model-Tier Configuration

Retrieval parameters are functions of the routing tier, not hardcoded.
A `model_tier_configs` object is loaded at runtime and governs retrieval
behavior per tier.

```json
{
  "local_7b": {
    "relevance_floor": 0.65,
    "max_context_tokens": 1500,
    "rrf_k": 60,
    "max_nodes": 5,
    "enable_multi_hop": false,
    "node_order": "relevance_desc",
    "prompt_structure": "strict_xml"
  },
  "cloud_frontier": {
    "relevance_floor": 0.50,
    "max_context_tokens": 4000,
    "rrf_k": 40,
    "max_nodes": 10,
    "enable_multi_hop": true,
    "node_order": "relevance_desc",
    "prompt_structure": "markdown"
  }
}
```

**Key decisions:**

**The tier is provisional at retrieval time.** Retrieval parameters depend
on the tier, but the routing rule derives the tier from the privacy flags of
the selected nodes — a loop. Resolution: retrieve under a provisional tier
(local if Ollama is reachable, else cloud); if privacy flags then force the
local tier after a cloud-config retrieval, re-pack the already-scored
candidates under the local config without re-querying (`packForTier` in
`retrieval/retrieve.js`).

**Local tier is stricter.** Irrelevant context degrades 7B models more than
frontier models. The local tier uses a higher relevance floor (0.65 vs 0.50),
fewer nodes (5 vs 10), and disables multi-hop expansion. This trades recall
for precision, which is the right tradeoff for small models.

**Multi-hop disabled on local tier.** Multi-hop retrieval increases context
volume and introduces indirectly-related nodes. Evidence suggests 7B models
are distracted by indirectly-relevant context in ways that frontier models
are not. Multi-hop is a cloud-tier feature only.

**Node ordering matters for small models.** The "lost in the middle" effect
is documented: 7B models attend most strongly to context at the beginning
and end of the context window, and miss information in the middle. Nodes are
ordered relevance-descending (most relevant first) in the injected context
block, not by recency or relationship type.

**Static prefix for KV cache retention.** The prompt is structured so that
system instructions and the most static nodes (project specs, unchanged
datasheets) appear at the very beginning. Ollama/llama.cpp caches KV states
for previous tokens — if the beginning of the prompt is identical across
iterative queries, the engine skips recomputing those tokens, reducing TTFT.

**Routing order (implemented).** The router decides from the nodes actually
selected, in this order: (1) any `privacy = 'local'` node forces the local
tier, above even the user's own per-query tier choice, and if the local model
cannot serve, the request is refused rather than rerouted; (2) an explicit
per-query tier choice (`user_override`); (3) no local model, meaning Ollama is
down or the chat model is not pulled, routes cloud (`no_ollama`); (4) otherwise
local (`context_size`: the provisional local pack fits the local budget by
construction). Complexity- and size-based upgrades to cloud wait for the cloud
tier and the benchmark to calibrate them. With Ollama down, retrieval runs
lexical-only (the query embedding also needs Ollama), so the router can still
decide.

**Script output is local-only context.** An approved script's output is
appended to its conversation so a follow-up can be about it, but the script
runs as the user and can print any file on the machine, private nodes'
sources included. So the output is never sent to the cloud, whatever the
project's nodes: a cloud turn continuing that conversation sends a fixed
stand-in (command and exit code only, the same every turn so the cached
prefix holds) and reports `routing.runOutput: 'withheld'`; only a local turn
reads the output itself. The route is unchanged: the user's tier choice still
stands, and the answer says it did not see the output.

**Static prefix, as implemented.** The static prefix is the system prompt,
byte-identical on every request; nodes follow relevance-descending, question
last. Ordering nodes for cache reuse instead would give up the
lost-in-the-middle ordering to help only queries that happen to share leading
nodes, while a re-ask with the same retrieval already gets a full prefix hit.
Measured on a 16 GB M4: a fresh 1,600–2,000-token prompt takes 10–15 s at
roughly 100–200 tokens/s of prefill, while an already-cached prompt reaches the
first token in 0.1–0.3 s. Prompt length, not model size, sets local TTFT.

**Prefill while the question is still being typed.** Because the question comes
last, everything above it is a reusable prefix. `POST /api/chat/prepare`
retrieves for the draft and prefills that prompt in the background, answering in
~50 ms with the nodes it would read so the UI can show the work in progress;
the draft is not logged as a query. Pressing enter then costs only the
question's own tokens: **TTFT 9.7 s → 0.12 s** on the live corpus. A reworded
question reuses the prefilled block whenever that block still covers the nodes
the new wording selects, so rephrasing does not discard the prefill; if the new
wording needs evidence the block lacks, the context is rebuilt and the cold path
applies.

**Conversations keep their context block.** A follow-up appends to the existing
prompt rather than rebuilding it, and nodes the earlier context lacked are
appended as a further block, because rebuilding would discard the cached prefix
— the expensive part — to save tokens that are cheap. A fresh block starts only
when the prompt outgrows its budget.

**The cloud tier runs on the user's own key.** It arrives per request in the
`x-anthropic-api-key` header and is never stored — not in the session, not in
the database, not in a log line; a test asserts that. A request without a key
has no cloud tier, so the router refuses a cloud decision rather than answering
somewhere else. Each answer records `cost_usd` from the model's own usage
numbers (migration 014), priced per model, because a metered tier cannot
recover the input/output split from a total afterwards. Model and effort
default to `claude-opus-5` at medium effort and are the two cost levers for the
Sprint 7 benchmark to tune against measured answer quality.

**Unit economics of a cloud answer.** A measured answer on the live corpus is
about 1,800 input tokens and 150 output tokens. At that shape:

| | per answer | per answer, 4-turn conversation with the context cached |
|---|---|---|
| `claude-sonnet-5` | $0.0051 | $0.0029 |
| `claude-haiku-4-5` | $0.0026 | $0.0015 |
| `claude-opus-5` (not offered) | $0.0128 | $0.0072 |

**No plan routes to Opus.** The metered tiers are sold in answers per month,
not in model prestige: at Student's $2.25 of monthly capacity, Opus uncached
buys 176 answers where Sonnet with caching buys about 776. `CLOUD_CHAT_MODEL`
can only name a model the product offers, so Opus cannot be configured back in
by accident. Caching is what makes a conversation cheap — the context block is
byte-identical across turns by construction (§ Conversations keep their context
block), so every turn after the first pays a tenth of its input price, and the
1.25× write has paid for itself by the second turn.

**Measured, 2026-09-27: the estimate above does not survive a user's choices.**
A comparison question with Cloud selected read eight sources and wrote a
thousand-word answer: **$0.0425**, eight times the $0.005 per-answer shape the
metered plans were priced on. Source count and answer length followed from
what the user chose, so a platform-paid allowance that the user steers leaves
the platform absorbing costs it does not control.

**Plans** (`billing/plans.js`, one edit changes pricing everywhere). Who decides
that an answer goes to the cloud is the line between plans, and every cloud
call's key is chosen in one place (`billing/credential.js`):

| Plan | Price | Cloud budget / month | Cloud answers / month | Choose Cloud or web | Auto may use the cloud | Model |
|---|---|---|---|---|---|---|
| Free | $0 | — | — | no | no | — |
| Key Pro | $5 | the user's own key | unlimited | yes | yes | Sonnet; Opus or Haiku by choice |
| Student | $12 | $4.37, platform-paid | 200 | no | hard questions, or local down | Sonnet |
| Engineer | $25 | $9.24, platform-paid | 340 | no | hard questions, or local down | Opus for hard, Sonnet otherwise |

Local answers are unlimited on every plan.

**Launch pricing is being changed, and the change is not implemented yet.**
The decision is: no tiers before an MVP; Free becomes the full local
experience plus the user's own Anthropic key; one $20/month subscription
replaces Key Pro, Student and Engineer, which are no longer sold. What that
subscription includes (proposed: platform-paid, metered cloud answers) and
the exact pull request that would carry it out are in
[docs/architecture/pricing-launch.md](docs/architecture/pricing-launch.md).
Until it merges, the table above is what the code does.

Budgets are derived, not set: price, less payment fees (Stripe Managed
Payments as merchant of record, 3.5% on top of 2.9% + $0.30, which also covers
sales tax, VAT and GST), times
(1 − the 60% target margin). Answer limits come from measured cost at full
quality — Sonnet ≈ $0.020 and Opus ≈ $0.055 per answer, 20% of Engineer's
cloud answers hard — rounded down so a typical user reaches the count before
the dollar budget (Student $4.00 of $4.37, a 63.4% margin; Engineer $9.18 of
$9.24, 60.3%, or 60.1% if the 3.5% also applies to 10% sales tax). Both are enforced; whichever runs out first stops the cloud. 450 and
900 were the targets; they fit only with half the cloud context, which cut the
cloud hit rate from 95% to 80% (90% at 3,500 tokens), so the limits came down
instead of the quality. Past half the week's budget every platform model
steps down one level (Opus → Sonnet → Haiku). A question is *hard* by its
wording (comparisons, causes, code changes, reviews), length, or being
multi-part (`routing/difficulty.js`); a lookup stays local. A "needs more
context" criterion was tried and removed: files split into many similar
chunks always leave strong chunks out, so it sent 9 of 20 benchmark lookups
to the cloud, one of them to Opus for $0.055.

- **Choosing the cloud is Key Pro only, as a hard block.** Off Key Pro an
  explicit Cloud or web request is refused before anything is retrieved, and
  the user's key header is never read, so it can never be sent.
- **Auto is the most efficient path.** It answers locally unless the question
  is hard or the local model cannot answer at all.
- **The plan comes from the account, not the engine.** The engine signs in
  to the control plane (`control/`, `control/API.md`) through the browser,
  with a loopback redirect and PKCE (`server/src/control/signin.js`), and
  keeps the device token sealed in `control_links`. Its plan rules read the
  control plane's `GET /v1/me`, cached for five minutes per user
  (`server/src/control/plan.js`). Signed out, offline or unconfigured
  (`CONTROL_URL` unset), the engine runs as Free: local answers only, never an
  error page.
- **The allowance is enforced, not reported.** Platform-paid answers go
  through the control plane's `POST /v1/cloud/messages`, which holds the
  platform key, checks the plan, the month's answers and the week's spend
  against its ledger, picks the model and charges every answer. The engine
  never holds a platform key; it pre-checks the limits `/v1/me` last reported
  so a spent allowance costs no round trip, and when the control plane refuses
  it answers locally if it can. Every attempt carries a fresh `requestId`.
- Every answer records **who paid** (`billed_to`): spend on a user's own key is
  not margin, and a total that mixes the two cannot be separated afterwards.
- **Billing** lives on the control plane (`control/src/billing`,
  `control/src/routes/billing.js`): Stripe Checkout with Managed Payments, the
  customer portal and the signed webhook that sets the account's plan. The
  engine's `/api/billing` routes forward to `/v1/billing*` with the device
  token, and hold no Stripe key, price or webhook of their own.

Two caps bound the worst case rather than trusting the average: the context
budget (4,000 tokens on the cloud tier) and `max_tokens` (2,048, against
measured answers of 40–280). A single Sonnet query therefore cannot exceed
about $0.03. `GET /api/usage` reports recorded spend per owner, with the
monthly projection that a metered price has to clear.

**The local model is a plain transformer on purpose.** A transformer's KV cache
can be rewound to the point where a prompt diverges; the hybrid linear-attention
layers in `qwen3.5:9b` can only append, so a reworded question over a cached
context costs 2.95 s there against 0.12 s on `qwen3:8b`. The default is
`qwen3:8b` for that reason, overridable with `OLLAMA_CHAT_MODEL`.

---

## 6. Database Configuration

### 6.1 HNSW index

```sql
CREATE INDEX ON nodes
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

HNSW over IVFFlat: faster query times, no periodic rebuilding as the graph
grows, and lower `m` limits RAM consumption leaving memory available for
the local 7B model on a 16GB M4.

### 6.2 PostgreSQL memory limits

```
shared_buffers = 1GB
work_mem = 16MB
```

If PostgreSQL consumes dynamic RAM unconstrained, the OS pages out the local
LLM weights, causing 10+ second latency spikes during generation. Hard limits
in `postgresql.conf` prevent this.

### 6.3 Materialized graph views

Common multi-hop relationships (complete `caused_by` chains for decision
nodes, full `part_of` hierarchies for specs) are pre-computed into a
materialized view updated asynchronously. Computing deep graph traversals
on the fly within the 300ms retrieval budget is not feasible.

### 6.4 Query embedding LRU cache

An in-memory Node.js LRU cache maps exact or highly similar query strings
to their 768-d nomic embeddings. Iterative engineering workflows frequently
re-ask similar queries ("what does X do?" / "how does X work?") — skipping
the embedding model pass for cached queries meaningfully reduces TTFT.

---

## 7. Signals to Log Now for Future Weight Learning

These signals are cheap to add during Sprint 4-6 and make the scoring
function learnable from real usage data later, without over-engineering
the current implementation.

| Signal | Where logged | What it enables |
|--------|-------------|-----------------|
| `inferred_task_type` | query_metrics | Validate centroid classifier, tune taskType boost |
| `task_confidence` | query_metrics | Weight learning: low confidence queries excluded |
| `nodes_in_context` | query_metrics | Already logged |
| `user_confirmed_useful` | query_metrics | Confirmed retrieval signal, breaks feedback loop |
| `follow_up_within_60s` | query_metrics | Implicit negative signal (re-ask = answer failed) |
| `node_position_in_context` | query_metrics | Validate lost-in-the-middle ordering hypothesis |
| `superseded_nodes_demoted` | query_metrics | Validate supersede demotion multiplier |
| `source_type_boost_applied` | query_metrics | Validate per-source boost for CAD/kicad nodes |
| `decay_λ_used` | query_metrics | Audit which λ value was applied per node type |

**Minimum viable signal for learning:**
`user_confirmed_useful` is the single most important signal. Without it,
all weight tuning relies on the 20-query benchmark and cannot adapt to
real user behavior. Implement a simple thumbs-up / no-follow-up heuristic
from Sprint 6 onward.

---

## 8. The 20-Query Benchmark — as built and as measured

`npm run benchmark` in `server/` (`src/benchmark/`) runs the golden set in
`server/benchmarks/queries.json` against the live corpus for the owner with the
most nodes, through the side-effect-free half of retrieval (`gatherCandidates`
+ `packForTier`), so it never bumps `access_count` or logs metrics. Each query
lists the nodes a correct answer needs — a project, optionally a path suffix,
optionally a content pattern for the one chunk of a ten-chunk file that
answers — and the judge scores the packed context against them.

**Categories (5 each), adapted to a corpus of files and repositories:**
codebase lookup ("what does `quantify_colonies` return"), cross-project
("which repositories use Flask" — any Flask chunk per project counts),
decision context (answered by design notes, runbooks and failure-analysis
summaries that exist as files), research context (thresholds, organism
profiles, validation notebooks, peripheral setup).

**Metrics per configuration:** hit rate (a relevant node is in the pack),
candidate hit rate (a relevant node cleared the floor at all — separating
retrieval failures from ranking and budget failures), recall over
expectations, MRR, task-inference accuracy, tokens injected, efficiency ratio,
retrieval latency. The ablation ladder (B v0 → C recency → D task → E
demotion → F full) and `--sweep param=v1,v2,…` layer on the same runner;
`--save` writes a row per configuration to `benchmark_runs` with the commit.

**Measured, 2026-09-23, 871 chunks across 9 repositories:**

| | local (5 nodes, 1,500 tokens) | cloud (10 nodes, 4,000 tokens) |
|---|---|---|
| hit rate, before v0.3 | 75% | 90% |
| hit rate, with definition term | **80%** | **95%** |
| candidate hit rate | 95% | 100% |
| MRR | 0.72 | 0.74 |
| task inference | 15/20 | 15/20 |
| tokens injected (mean) | 1,439 | 3,872 |
| retrieval latency (warm) | 5–9 ms | 5–6 ms |

**What the remaining misses are.** Every local miss but one is a *budget*
failure: the relevant chunk cleared the floor and ranked in the top five, but
two or three ~750-token chunks fill 1,500 tokens first (a README of the same
project, or a test file). The exception is a semantic gap ("how does
focus-guard decide that the user is distracted" against a `detector.py` that
never uses the word). Larger budgets do not help within `max_nodes = 5`;
smaller chunks for the local tier, or a budget-aware pack that trades one
large chunk for two small ones, are the next experiments.

**Tried after v0.3 and rejected, 2026-09-24.** Both aimed at the remaining
local misses; neither ships.

- *Budget-aware packing.* Chunk sizes are uniform (median 738 tokens, three
  quarters above 700), so there is no smaller chunk to trade for, and the
  wanted chunk is the same size as those that beat it. A per-file cap (at
  most one or two chunks of any file) left local hit rate at 80% and cut
  cloud to 90% at one per file; budgets of 1,600 and 2,300 tokens either
  lost a query or changed nothing.
- *English stemming in the lexical index.* Stems alone rescued one local
  miss ("dosing schedule" meets `dose`) but dropped the answer one rank in
  five queries on both tiers (MRR 0.72 → 0.67 local, 0.74 → 0.67 cloud) and
  lost one cloud expectation: "tests", "testing" and "tested" become one
  term, and a runbook repeating it outranks the workflow file that answers.
  Indexing exact words at weight A and stems at weight B was worse still
  (cloud 95% → 90%). `ts_rank_cd` is frequency-weighted, and stemming raises
  the frequency of exactly the common words that already crowd the pack.

What the two results say together: the remaining local misses are not a
packing or a lexical problem. The wanted chunk clears the floor and ranks
fourth or fifth among chunks of near-identical similarity (0.66–0.73). The
next lever that could reach them is a reranking pass over the top ten,
which costs a model call per query and belongs in a latency budget decision,
not a constant change.

**What this sample size can and cannot show** is unchanged from v0.2: a
15-point change in hit rate is a signal at 20 queries, a 5-point change is
one query, and learning-to-rank still needs 200+ labelled queries. The
definition term's 5-point gain is one query on each tier — but it is the
query the benchmark was written around, it is the same query on both tiers,
and the fix is stable across a 2× range of weights.

---

## 9. The Agent Workspace

The contract for everything in this section (schema, `can()`, the capability
registry, the ModelPort, events, the run lifecycle, HTTP shapes, reserved
migration numbers) is
[docs/architecture/agent-workspace.md](docs/architecture/agent-workspace.md).
This section records the decisions and why they were made; the contract has
the detail and is the document to change when an interface changes.

### 9.1 Why the graph is the agent's memory

A conventional agent keeps every step in its context window, so step 40 pays
for steps 1 to 39 and a small local model cannot run the task at all. Here a
step reads a packed slice of the graph (the §3 retrieval, boosted toward the
run's plan and the nodes it wrote), acts once, verifies, and writes what it
learned back as linked nodes. The slice has a fixed budget (1,500 tokens, 8
nodes; `server/src/workspace/runner/slice.js`), so a step's prompt is the
same size late in a task as early in it. §9.11 is where that is measured.

### 9.2 Agents, roles and the permission check

An **agent** is a user-owned, editable record: a role, a permission level
(`manual`, `supervised`, `sandboxed`, `agentic`; new agents are
`supervised`), per-capability overrides, read and write scopes, a model
policy (`local_only`, `local_cloud`, `own_key`), a per-run budget and a state
(`active`, `paused`, `killed`; `killed` is the kill switch). A **role** is a
template copied into the agent: six built-in templates live in code
(`server/src/workspace/roles.js`: Researcher, Builder, Debugger, Physicist,
Hardware Engineer, CAD Designer) so they can improve without a migration, and
a user's own roles are stored in `agent_roles`. A role names capability
**tags**, never plug-ins.

**`can(agent, capability, context)` → `allow | ask | deny`**
(`server/src/workspace/permissions.js`) is the only place that decides what
an agent may do, and every capability call in the runner asks it first. It
applies hard denials first (agent not active, unknown capability, model-written
code outside the OS sandbox, outside the read or write scope, network while
offline, cloud on `local_only` or with private context), then the agent's
override, then the level's default. Hard denials fail closed: a context field
the caller leaves out never widens access. Retrieval for a step filters its
candidates with `inReadScope`, so a slice never holds a node the agent may
not read. *Why one function:* a rule changed there changes it everywhere, and
the UI's capability grid asks the same function (`GET /api/agents/:id/can`).

### 9.3 Tasks, runs and the runner

A **task** is the work (instructions, agent, project, an optional five-field
UTC cron `schedule`); a **run** is one execution, made of **steps**. Every
step follows the same five stages and the runner never skips one: read the
slice, act through exactly one capability, verify, write back (only after
verification passes), checkpoint (step and position in one transaction, so a
restart resumes at the next step and never repeats a finished one). The first
step writes the plan; each later step starts with a **step chooser**, one
model call that answers strict JSON naming a capability and its input, which
is validated against the role and the capability's schema before `can()` is
asked. Five failed steps in a row fail the run; a budget (tokens, dollars,
wall clock, steps, default 50 steps) stops it with `budget_exceeded`. The
runner is `server/src/workspace/runner/` (`execute.js`, `chooser.js`,
`slice.js`, `writeBack.js`, `budget.js`).

Write-back nodes **inherit privacy**: a node derived from any `local` node is
`local` (`inheritPrivacy`, `server/src/workspace/nodeTypes.js`), so nothing an
agent learned from a private note can reach a cloud model later.

### 9.4 The durable queue and cron

`agent_runs` is the queue (migrations 021, 025–027). A worker claims the
oldest `queued` run, or a `running` run whose lease expired, with `FOR UPDATE
SKIP LOCKED`, holds a lease it renews at each step boundary, and a run claimed
more than three times without progress is failed rather than reclaimed
forever. Every status change is conditional on the status it expects, so a
pause or kill from the API is never overwritten by a worker that had not seen
it; the full transition table is in the contract ("Run lifecycle across
paths"). On shutdown a worker hands its run back at the next step boundary,
waiting at most 10 s.

The scheduler (`runner/scheduler.js`, every 30 s) enqueues a due task for the
exact slot (`scheduled_for`, unique per task) and advances `next_run_at` in
the same transaction, so two engines cannot enqueue one slot twice. Missed
slots are not replayed: a laptop that slept through a night of hourly runs
runs once on waking. Schedules are parsed by `server/src/workspace/cron.js`,
which refuses a schedule that can never fire. The engine starts one worker
and one scheduler in `server/src/index.js`; `WORKSPACE_WORKERS` sets how many
runs execute at once.

### 9.5 Approvals

When `can()` answers `ask`, the worker records an `agent_approvals` row (at
most one pending per step), parks the step and the run in
`waiting_approval` and releases the run. Resolving the last pending approval
(`POST /api/approvals/:id`) queues the run again; the worker re-decides the
parked step before running it, so an override or kill made in the meantime
still wins. The cloud is the one exception: a run asks **once** to use the
cloud for its planning and hard steps and keeps working locally while that
question is open (§9.7).

### 9.6 Events and the live view

`GET /api/workspace/events` is Server-Sent Events, for one run or all of the
user's runs (`server/src/workspace/events.js`, `routes/workspace/events.js`).
Event ids carry the engine's boot and one engine-wide sequence, so a client
reconnecting with `Last-Event-ID` gets what it missed from a bounded replay
buffer (5,000 events), and an id from an earlier boot replays everything still
buffered. Events are the live view, not the record: after a restart the UI
reloads the run and its steps over HTTP. Events stay on the machine; prompt
and answer text never reach the control plane.

The client (`client/src/workspace/`) registers three tabs beside the
conversation, Agents, Activity and Approvals, and holds one `EventSource` for
the page. Agents appear on the map as uncoloured circles that take their
colour only on the nodes they are touching or just wrote.

### 9.7 Models: the ModelPort

Every model call in the runner goes through one interface with three
adapters (`server/src/workspace/modelPort.js`): **local** (Ollama, offline,
cost 0), **own_key** (Anthropic on the user's own key) and **platform** (the
control plane's `POST /v1/cloud/messages` with the device token, §9.10).
`selectAdapter` decides what the plan and the policy make possible (execution
steps stay local; only planning and steps marked hard may go to the cloud);
`can(agent, 'cloud_model', …)` decides what this agent is permitted. When the
platform refuses (signed out, offline, allowance spent), the runner answers
that call locally and records the adapter actually used; that is the one place
it looks at an adapter's outcome. Every model call's cost is a row in
`agent_run_costs`, which holds token counts and dollars and never prompt or
answer text.

Background runs have no `own_key` adapter: the user's key travels with each
request and is never stored, so a run that outlives the request keeps its
planning local.

### 9.8 Capabilities, plug-ins and verticals

A plug-in (`server/src/plugins/<name>/`) declares capabilities (a namespaced
name, tags, the permission `can()` is asked about, an input schema, verifiers
and `run(input, ctx)`) and verifiers. `registerPlugin`
(`server/src/workspace/capabilities.js`) validates the declaration and
refuses duplicates, so a bad plug-in fails at start-up rather than mid-run.
`server/src/plugins/registry.js` lists the built-in plug-ins and the worker
registers them when it is created. Because roles select by tag, a new
vertical reaches every role that carries its tag without touching the role.
A capability gets only what `ctx` gives it (owner, agent, run, step, project,
local path, the run's sandbox, a ModelPort, an abort signal, `emit`).

| Plug-in | Tag(s) | What it adds | Detail |
|---|---|---|---|
| `code` | `code`, `scripts`, `sandbox` | search, read, edit (sandbox copy only), run a declared script, run model-written code (OS sandbox only); verifiers typecheck, lint, build, tests | contract, "Sandbox" |
| `graph` | `graph` | `graph.write_artifact`: one verified `artifact` note | contract, "Sandbox" (graph plug-in) |
| `research` | `research`, `web` | Zotero / Better BibTeX ingest with PDF text; sweep, extraction table, related-work draft, web search (SearXNG when configured); verifiers that every citation resolves and every quotation is verbatim | contract, "Research" |
| `physics` | `physics` | derive (with units and limiting cases), compute (model-written Python on Pint quantities with an independent cross-check), check; all Python in the OS sandbox | contract, "Physics" |
| `cad` | `cad` | STL and STEP inspection, mass properties, interference; parametric edits with CadQuery in the OS sandbox | contract, "The CAD plug-in"; [solidworks-connector.md](docs/architecture/solidworks-connector.md) (designed, not built) |
| `kicad` | `kicad` | schematic and board ingest, net and footprint queries, BOM, schematic review; ERC / DRC verifiers through `kicad-cli` in the OS sandbox | contract, "KiCad" |

The conventions every vertical follows: ingest writes stable `external_id`s
so re-ingest updates in place, and runs as a background job that never needs
the network; anything that runs model-written code or an external tool on
model input goes through the OS sandbox; a verifier whose tool is missing
reports `unavailable`, never a pass it did not check. GitHub
(`server/src/plugins/github/`) is an ingest source, not an agent capability.

### 9.9 The OS sandbox

A run that edits files, runs scripts or runs model-written code gets one
private copy of the project (`server/src/workspace/sandbox/`, made by the
runner in `runner/sandbox.js`): an independent clone of HEAD, not a `git
worktree`, under the app data directory (`SCOPE_DATA_DIR`, else the
platform's application-data folder), never inside the user's checkout. It is
reused by every step of the run, recorded on the run's checkpoint so a resumed
run finds it, and removed when the run ends. `runSandboxed` runs one process
with a fixed argument list (never a shell) under **bubblewrap** on Linux (no
network, read-only system, only named directories writable, clear
environment, resource limits) or **sandbox-exec** on macOS; with neither it
refuses with `sandbox_unavailable` and runs nothing. *Why a clone and not a
worktree:* nothing in the copy shares the user's `.git`, and host-side git
always names the copy's git directory explicitly, so code in the sandbox
cannot change what git runs on the host.

### 9.10 The engine ↔ control link

The engine is local; accounts, plans, Stripe billing and the platform's
Anthropic key live on the hosted control plane (`control/`,
[control/API.md](control/API.md), [control/README.md](control/README.md)),
which auto-deploys to Railway. The engine signs in through the browser with a
loopback redirect and PKCE (`server/src/control/signin.js`), so the password
never passes through the engine, and keeps the device token sealed with
AES-256-GCM under a key derived from `SESSION_SECRET`
(`server/src/control/tokenBox.js`, table `control_links`, migration 031).
Every call to the control plane goes through `server/src/control/client.js`.
The plan comes from `GET /v1/me`, cached per user for five minutes
(`server/src/control/plan.js`); after a failed refresh the control plane is
not asked again for 30 seconds. Signed out, offline or unconfigured
(`CONTROL_URL` unset), the engine runs as Free: local only, never an error
page. Platform-paid answers, for the conversation and for agent runs alike,
stream from `POST /v1/cloud/messages`, which checks the plan and the ledger,
picks the model and charges every answer; every attempt carries a fresh
`requestId` (`server/src/control/platform.js`). The engine holds no platform
key and no billing tables of its own.

### 9.11 Measuring the edge: the task benchmark

`npm run benchmark:tasks` (`server/src/benchmark/tasks/`) runs whole tasks,
not chat turns, through four arms: Scope on the local model, Scope with a
cloud planner, and the standard full-transcript tool loop on Sonnet and on
Opus with the same tools. A task counts as completed only when its objective
check passes (the fixture's own tests in the OS sandbox, a cited answer read
against a key, a physical quantity within 0.5% of a hidden reference, a measured STL), never
because a model said so. `--dry` (the default, run in CI) plays scripted
model replies through every arm at $0, so it measures the harness and the
economics, not model quality; `--live-local` and `--live` (a hard spending
cap) are for that. The catalog has six code tasks, a research task, a physics
task, a CAD task that runs where CadQuery is installed, and a KiCad task that
is listed as a pending gate until a schematic-edit capability exists. Method,
arms and the measured results are in the contract ("Measuring the edge"),
and the figures quoted to users are in [docs/demo.md](docs/demo.md).

### 9.12 The local demo

`npm run demo` (`server/src/demo/`, [docs/demo.md](docs/demo.md)) checks the
prerequisites and says exactly what to run for anything missing (it never
downloads a model itself), creates and migrates its own `scope_demo`
database, seeds a first-year physics project with an agent and its tasks
(resetting the demo account's data each time), starts the engine on loopback,
signed out and with agent networking off (`WORKSPACE_OFFLINE=1`), and builds
and serves the app. *Local mode* signs the browser on the same machine in to
the demo account without a password; it is held to the demo account,
`NODE_ENV=development`, a loopback-only engine and same-machine requests
(`server/src/config/localMode.js`), and the engine refuses to start if it is
misconfigured. CI runs the demo end to end in a browser, with a scripted
model in place of Ollama's chat (`client/playwright.demo.config.js`).

---

## 10. What the Literature Does Not Settle

These items are experiments, not decisions. They should be tested empirically
on the 20-query benchmark rather than assumed from prior work.

1. **Optimal cosine relevance floor for nomic-embed-text on engineering text.**
   *Settled for hit rate (v0.3):* 0.50–0.75 changes nothing on the live
   corpus because the lexical channel admits candidates regardless of the
   floor and the pack is budget-bound. Lowering it to 0.50 raises candidate
   hit rate from 90% to 95% at the cost of a worse efficiency ratio (more
   projects in the baseline). 0.65 stays for the local tier.

2. **Whether session context improves intent inference enough to justify
   the implementation cost.** The hypothesis (recently accessed node types
   provide a useful prior) is reasonable but unvalidated on engineering
   workflows specifically.

3. **Whether one-hop graph expansion helps or hurts on the local tier.**
   *Settled for this corpus (v0.3):* neither. The ablation ladder's v0
   rung (expansion off) and the full configuration score identically on
   every query, because the live graph has only `part_of` edges and those
   run chunk → file → repository, so expansion can only ever add a
   repository node. The question reopens once `caused_by`, `supersedes`
   and `references` edges exist between real nodes; the harness is ready.

4. **Optimal λ values per node type.** The values in Section 4 are
   principled estimates. Real engineering workflows may have very different
   temporal patterns. These must be tuned against the benchmark and
   eventually against real usage telemetry.

5. **Whether the "lost in the middle" ordering effect holds at 1500 tokens.**
   Most evidence for context position effects is on longer context windows
   (4k-32k tokens). Whether ordering matters at 1500 tokens for 7B models
   specifically is not established.

---

## 11. What This Document Is Not

This is not an API specification, a database migration plan, or a deployment
guide. Those live in the sprint handoff documents and the README. This
document records decisions and reasoning — it should be readable by someone
who has never seen the codebase and should not require reading the code to
understand the system.

