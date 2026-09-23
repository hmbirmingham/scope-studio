# Scope Studio — Architecture Decision Record
**Version:** 0.2 (v1 retrieval implemented; §4 taskType and recency anchor corrected, §5 tier loop resolved, routing order recorded)
**Author:** Hynes Birmingham, Fourier Studios
**Last updated:** September 2026
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
                 + sourceType(node))
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
```

**Default parameters to tune first against the 20-query benchmark:**
1. `λ` values per node type (recency decay rates) — highest expected impact
2. `project` boost magnitude (0.3 is a guess, may need to be 0.15-0.5)
3. Relevance floor threshold (0.55 is a guess on real nomic similarity distributions)

**Parameters to tune second:**
4. `taskType` boost magnitude
5. `sourceType` boost magnitude
6. `supersedeDemotion` multiplier (0.1 vs 0.0 vs 0.25)

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
| `claude-opus-5` | $0.0128 | $0.0072 |
| `claude-sonnet-5` (default) | $0.0051 | $0.0029 |
| `claude-haiku-4-5` | $0.0026 | $0.0015 |

The default is Sonnet because the metered tiers are priced in answers per
month, not in model prestige: at Student's $2.25 of monthly capacity, Opus
uncached buys 176 answers and Sonnet with caching buys about 776. Caching is
what makes the conversation cheap — the context block is byte-identical across
turns by construction (§ Conversations keep their context block), so every turn
after the first pays a tenth of its input price, and the 1.25× write has paid
for itself by the second turn.

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

## 8. Ablation Plan — 20-Query Benchmark

The benchmark covers 4 categories (5 queries each):
- **Codebase lookup:** "what does `quantify_colonies` return?"
- **Decision context:** "why did we choose watershed over contour detection?"
- **Cross-project:** "which repos use Flask?"
- **Research context:** "what anomaly threshold did we settle on?"

Each query runs against:
A. Full-context baseline (no retrieval, paste everything)
B. v0 retrieval (current pipeline)
C. v1 with recency decay only (isolate recency fix)
D. v1 with decay + task inference (isolate task boost)
E. v1 with decay + task + supersede demotion (isolate demotion)
F. v1 full (all components)

**Metrics per run:**
- `answer_correct` (binary, ground truth hand-labeled)
- `tokens_injected` vs `tokens_available` (efficiency ratio)
- `retrieval_latency_ms`
- `nDCG@5` (requires relevance judgments for top-5 retrieved nodes)

**What this sample size can and cannot show:**
At 20 queries, individual component ablations (C vs D vs E) can detect
improvements of ~15% in answer_correct or ~20% in efficiency ratio as
statistically meaningful. Smaller effects will be noise at this sample
size. The benchmark is sufficient to validate that the system works and
to tune the highest-impact parameters (λ, relevance floor). It is not
sufficient to validate learning-to-rank approaches — that requires 200+
labeled queries.

---

## 9. What the Literature Does Not Settle

These items are experiments, not decisions. They should be tested empirically
on the 20-query benchmark rather than assumed from prior work.

1. **Optimal cosine relevance floor for nomic-embed-text on engineering text.**
   0.55 is a guess. The actual distribution of cosine similarities for
   relevant vs. irrelevant engineering nodes under nomic needs to be
   measured empirically on real data.

2. **Whether session context improves intent inference enough to justify
   the implementation cost.** The hypothesis (recently accessed node types
   provide a useful prior) is reasonable but unvalidated on engineering
   workflows specifically.

3. **Whether one-hop graph expansion helps or hurts on the local tier.**
   Multi-hop is disabled. Whether even one-hop expansion improves local
   tier accuracy or introduces distraction is unclear from the literature
   and should be ablated explicitly (v1 with and without one-hop on
   local tier queries).

4. **Optimal λ values per node type.** The values in Section 4 are
   principled estimates. Real engineering workflows may have very different
   temporal patterns. These must be tuned against the benchmark and
   eventually against real usage telemetry.

5. **Whether the "lost in the middle" ordering effect holds at 1500 tokens.**
   Most evidence for context position effects is on longer context windows
   (4k-32k tokens). Whether ordering matters at 1500 tokens for 7B models
   specifically is not established.

---

## 10. What This Document Is Not

This is not an API specification, a database migration plan, or a deployment
guide. Those live in the sprint handoff documents and the README. This
document records decisions and reasoning — it should be readable by someone
who has never seen the codebase and should not require reading the code to
understand the system.

