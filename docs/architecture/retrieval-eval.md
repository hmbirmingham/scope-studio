# Retrieval and difficulty eval

Two small evals that run offline and give the same answer every time, so a change to `server/src/retrieval/**` or `server/src/routing/difficulty.js` can be measured before it is kept. The live benchmark (`npm run benchmark`) still needs a real ingested corpus. These evals don't.

## Retrieval: `npm run eval:retrieval`

- **Corpus:** `server/benchmarks/retrieval-eval.json` has 63 nodes in six projects: code, a KiCad board, a Zotero library, physics, CAD and agent-run memory. It has 33 edges. Every node type and relationship type from migrations 020 and 039 appears. Node contents follow the shapes the ingesters write.
- **Queries:** 47 labelled questions. Each one names the nodes a correct answer needs. They fall into seven groups: code, cross, kicad, research, physics, cad and workspace.
- **Isolation:** the eval seeds the corpus under a throwaway owner (`retrieval-eval@example.invalid`) and deletes that owner when it finishes. It never records metrics and never changes access counts. It runs against `DATABASE_URL`.
- **Two modes, reported separately:**
  - **lexical:** no query embedding. This is how the test suite retrieves, and how a machine without Ollama does. The tests had no deterministic fake embedder to reuse; they retrieve lexical-only.
  - **nomic:** real `nomic-embed-text` on the configured Ollama, with task centroids. This mode is skipped when Ollama is unreachable.
- **Metrics (tier `local_7b`):**
  - recall@1, recall@5 and recall@10 over the ranked candidates.
  - MRR.
  - coverage: the share of labelled nodes retrieved at any rank.
  - packed: recall within the context the local tier actually sends.
  - unscored: the number of candidates whose score is not a number.

## Difficulty: `npm run eval:difficulty`

Accuracy, a confusion matrix and hard precision/recall for `questionDifficulty`, on two sets:

- **held-out:** `server/benchmarks/difficulty-eval.json`, 50 questions (25 easy, 25 hard) across the verticals. I wrote it before changing `difficulty.js`.
- **sessions:** the turns in `server/benchmarks/sessions/**`, 124 questions. A lookup turn counts as easy and a hard turn as hard. Follow-ups are left out because their difficulty depends on the turn before.

Both sets' misroutes guided the changes below, so both numbers are in-sample. Treat them as "the rule now handles these phrasings", not as a generalisation estimate.

## Before and after

Baseline is `336f507`. "Tuned" is after the lexical change (change 6 below). "Final" adds the scoring fix and the deterministic tie-break (changes 7 and 8).

Baseline and Tuned are means of 5 runs. Under NaN ordering their figures could move between runs; for example, Tuned lexical recall@1 ranged from 70.2% to 73.4%. Final is one number: five runs gave byte-identical results.

| Metric | Baseline | Tuned | Final |
|---|---|---|---|
| lexical recall@1 | 70.2% | 72.3% | 72.3% |
| lexical recall@5 | 89.4% | 92.6% | 93.6% |
| lexical recall@10 | 89.4% | 93.6% | 93.6% |
| lexical MRR | 0.816 | 0.851 | 0.846 |
| lexical coverage | 89.4% | 93.6% | 93.6% |
| lexical packed | 89.4% | 92.6% | 93.6% |
| nomic recall@1 | 78.4% | 79.4% | **75.5%** |
| nomic recall@5 | 95.7% | 97.9% | 97.9% |
| nomic recall@10 | 96.0% | 98.1% | 98.9% |
| nomic MRR | 0.902 | 0.923 | **0.894** |
| nomic coverage | 96.8% | 98.9% | 98.9% |
| nomic packed | 95.7% | 97.9% | 97.9% |
| unscored candidates per run (lexical / nomic) | 158 / 199 | 177 / 210 | 0 / 0 |
| kicad group recall@5 (lexical / nomic) | 65.4% / 88.5% | 76.9% / 96.2% | 80.8% / 96.2% |
| identical across runs | no | no | yes |
| difficulty held-out: accuracy | 60.0% | 94.0% | 94.0% |
| difficulty held-out: hard precision / recall | 77.8% / 28.0% | 100% / 88.0% | 100% / 88.0% |
| difficulty sessions: accuracy | 91.9% | 100% | 100% |
| difficulty sessions: hard precision / recall | 97.3% / 80.0% | 100% / 100% | 100% / 100% |

### Why nomic recall@1 and MRR went down, and why that is right

Before the fix, every node type added by migrations 020 and 039 scored NaN under recency decay. That covers schematics, nets, notes, derivations, parts and findings, among others. Anything reached over the newer edge types scored NaN too. A sort comparator that returns NaN does not order those nodes; they tend to stay in the order they arrived in, which is dense-similarity order, and that is often right at rank 1.

The baseline and Tuned top-1 figures therefore include answers that only came first by accident. The same mechanism put other answers in the wrong place, and moved them between runs. Once every node has a real score, the boosts apply to the vertical nodes as they do to the others.

Against the baseline, nomic top-1 changed on 7 of 47 queries:

- **Gained:**
  - `kc-u1-pins`, `ws-result`: a correct node now reaches rank 1.
  - `kc-outline`: the board now ranks above a CAD part.
- **Lost:**
  - `code-peak`: the question is inferred as research, so a decision and a finding are boosted over the source file that defines the constant.
  - `ws-plan`: the finding is boosted over the plan node.
  - `kc-bom-caps`: the AP2112 datasheet ranks above the BOM rows.
  - `kc-led-net`: a near-tie, now decided the other way.

The losses come from the task-type boost (and, for `kc-led-net`, the tie-break). It now sees these node types for the first time, and its quality is now visible and stable enough to tune. Before, NaN ordering hid it. Lexical retrieval has no task boost, and it gained: recall@5 rose from 92.6% to 93.6% and MRR moved from 0.851 to 0.846.

## Changes

Each change below is its own commit.

1. **Change-verb requests:** a request that opens with fix/add/make/change/update/rename/remove/convert counts as hard.
2. **Drafting requests:** a request that opens with draft/write/compose counts as hard.
3. **Judgement questions:**
   - "is/does/will … safe/enough/race-free/hold up"
   - a request that opens with "should we"
   - "what would break/happen"
4. **Proposals, derivations, explanations and check runs:** a request that opens with suggest/propose/derive/explain, and "run a … check".
5. **Review and plan, narrowed:** these words now count only when they lead the request or act on an object. Before, "open peer review", "the review queue page" and "show me the plan for…" went to the cloud.
6. **Reference designators in lexical retrieval:** a two-character term that mixes a letter and a digit (C2, U1, J1) is now kept. Before, the query side dropped every term shorter than three characters, even though the index stores these as lexemes.
7. **Every node and relationship type gets a weight.** This is a correctness fix, not tuning.
   - What it does:
     - Every node type gets a `DECAY_LAMBDA`, with a file-like fallback for types added later.
     - Every relationship gets an `EDGE_WEIGHTS` entry, with a 0.5 fallback for types added later.
     - The vertical types join the hardware and research task boosts.
     - CAD nodes share the KiCad source boost for hardware questions.
   - Guard: `test/unit/scoreVocabulary.test.js` reads the allowed values from the latest `nodes_type_check` and `node_relationships_type_check` in the migrations. It fails if a type has no weight, so a new vertical cannot reintroduce the NaN.
8. **Deterministic ties:**
   - Fused and expanded candidates tie-break on node id.
   - The lexical query orders by rank, then id, so the same rows survive its `LIMIT`.
   - The dense query keeps distance alone. A second sort key would stop pgvector using the HNSW index, and exact distance ties are rare.
   - The eval seeds node ids derived from the node keys, so a reseeded corpus ties the same way.
   - A test checks that two reseeded runs rank identically.

Changes 1–6 each improved the metrics without regressing any. Changes 7 and 8 are kept as bug fixes despite the nomic top-1 change explained above.

## Tried and reverted

- **Plural-to-singular matching in lexical retrieval** ("capacitors" also matching "capacitor"):
  - Nothing improved.
  - Lexical recall@1 fell from 72.3% to 70.6%, and the research group's recall@1 from 100% to 88.9%.
- **A bare leading "check … for" as hard:**
  - It routed "check the BOM for the part number of the MOSFET", a lookup, to the cloud.
  - I narrowed it to "run a … check". Measured at that step, held-out accuracy was 90.0% with the narrow form against 92.0% with the broad one: the narrow form misses one held-out question.
- **Variants of change 7.** Each was worse on nomic recall@1 or MRR than the version kept:
  - recency rates alone
  - recency rates plus task types, without edge weights
  - edge weights and source boost without the task types
  - all run memory (plan, step, artifact) under the research boost, which also dropped code recall@5 from 100% to 88.9%
  - run memory with no task boost at all, which dropped workspace recall@1 to 30%

## Next

The remaining top-1 losses are in the task-type boost: a misinferred task, run memory, and a datasheet outranking BOM rows. With rankings now stable, tuning `TASK_NODE_TYPES` and the boost size against this eval is the obvious next step.
