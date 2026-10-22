# Retrieval and difficulty eval

Two small evals that run offline and give the same answer every time, so a change to `server/src/retrieval/**` or `server/src/routing/difficulty.js` can be measured before it is kept. The live benchmark (`npm run benchmark`) still needs a real ingested corpus. These evals don't.

## Retrieval: `npm run eval:retrieval`

- **Corpus:** `server/benchmarks/retrieval-eval.json` has 63 nodes in six projects: code, a KiCad board, a Zotero library, physics, CAD and agent-run memory. It has 33 edges. Every node type and relationship type from migrations 020 and 039 appears. Node contents follow the shapes the ingesters write.
- **Queries:** 47 labelled questions. Each one names the nodes a correct answer needs. They fall into seven groups: code, cross, kicad, research, physics, cad and workspace.
- **Isolation:**
  - The eval seeds the corpus under a throwaway owner (`retrieval-eval@example.invalid`) and deletes that owner when it finishes. It never records metrics and never changes access counts.
  - It runs against `DATABASE_URL`, and refuses unless the host is local. A local database also needs "test" or "eval" in its name, or the `--allow-database` flag.
  - It holds a Postgres advisory lock for the run, so a second run refuses rather than deleting the first one's corpus.
  - On SIGINT or SIGTERM it drops its owner before exiting.
- **Reproducible anywhere:**
  - Retrieval is scoped to the eval's owner, and the node ids are derived from the node keys. So the numbers do not depend on what else the database holds.
  - A near-empty database (freshly migrated, then `npm run centroids`) gave byte-identical results to the shared test database.
- **Two modes, reported separately:**
  - **lexical:** no query embedding. This is how the test suite retrieves, and how a machine without Ollama does. The tests had no deterministic fake embedder to reuse; they retrieve lexical-only.
  - **nomic:** real `nomic-embed-text` on the configured Ollama. This mode is skipped when Ollama is unreachable.
    - The eval never writes the shared `task_centroids`; it only reads them. If they are missing, the nomic run turns task inference off and says so in its report.
    - The figures below are with centroids present (`npm run centroids`). With task inference off, a fresh database gave nomic recall@1 78.7% and MRR 0.912.
- **Metrics (tier `local_7b`):**
  - recall@1, recall@5 and recall@10 over the ranked candidates.
  - MRR.
  - coverage: the share of labelled nodes retrieved at any rank.
  - packed: recall within the context the local tier actually sends.
  - unscored: the number of candidates whose score is not a number.

## Difficulty: `npm run eval:difficulty`

Accuracy, a confusion matrix and hard precision/recall for `questionDifficulty`, on three sets:

- **held-out:** `server/benchmarks/difficulty-eval.json`, 50 questions (25 easy, 25 hard) across the verticals. I wrote it before changing `difficulty.js`.
- **sessions:** the turns in `server/benchmarks/sessions/**`, 124 questions. A lookup turn counts as easy and a hard turn as hard. Follow-ups are left out because their difficulty depends on the turn before.
- **adversarial-easy:** `adversarial_easy` in the same file, 19 plain lookups that borrow the hard words:
  - "Explain what dispose_engine does"
  - "Does RedisBackend hold a lock while polling?"
  - "Is the safe mode flag documented anywhere?"
  - "Write down the pin numbers of J1"
  - "Update me on what the Q3 note says"

  A review found the rule sending these to the paid cloud. They are kept out of the held-out set so it stays as first written. A unit test fails if any of them routes to the cloud.

The misroutes in all three sets guided the changes below, so the numbers are in-sample. Treat them as "the rule now handles these phrasings", not as a generalisation estimate.

## Before and after

Baseline is `336f507`. "Tuned" is after the lexical change (change 6 below). "Final" is the branch head: it adds the scoring fix and the deterministic tie-break (changes 7 and 8), and the narrowed difficulty rule (change 9).

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
| difficulty held-out: accuracy | 60.0% | 94.0% | 92.0% |
| difficulty held-out: hard precision / recall | 77.8% / 28.0% | 100% / 88.0% | 100% / 84.0% |
| difficulty sessions: accuracy | 91.9% | 100% | 100% |
| difficulty sessions: hard precision / recall | 97.3% / 80.0% | 100% / 100% | 100% / 100% |
| difficulty adversarial-easy: accuracy (all easy) | 100% | 15.8% | 100% |

For difficulty, "Tuned" is the rule after changes 1–5, before the review. Those changes had made the baseline's 100% on adversarial-easy fall to 15.8%. Change 9 restores it, at the cost of one held-out hard question: "does the LED resistor value give a safe current" now stays local.

Final confusion matrices (rows are the actual label, columns the prediction):

```
held-out      easy  hard   sessions    easy  hard   adversarial-easy  easy  hard
  easy          25     0     easy        79     0     easy              19     0
  hard           4    21     hard         0    45
```

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

The losses come from the task-type boost (and, for `kc-led-net`, the tie-break). Evidence: the same final code with task inference off scores nomic recall@1 78.7% and MRR 0.912. It now sees these node types for the first time, and its quality is now visible and stable enough to tune. Before, NaN ordering hid it. Lexical retrieval has no task boost. Its recall@5 and packed recall rose from 92.6% to 93.6%, and its MRR dipped from 0.851 to 0.846. On `kc-3v3` and `kc-u1-pins`, a net or a finding that now has a real score ranks one place above the U1 symbol.

## Changes

Each change below is its own commit.

1. **Change-verb requests:** a request that opens with fix/add/make/change/update/rename/remove/convert counts as hard.
2. **Drafting requests:** a request that opens with draft/write/compose counts as hard.
3. **Judgement questions:**
   - "is/does/will … safe/enough/race-free/hold up"
   - a request that opens with "should we"
   - "what would break/happen"
4. **Proposals, derivations, explanations and check runs:** a request that opens with suggest/propose/derive/explain, and "run a … check". Change 9 narrows "explain".
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
   - The dense query orders by distance, then id. pgvector still uses the HNSW index for it: on PostgreSQL 18 with pgvector 0.8.7, EXPLAIN shows an Incremental Sort on id over an Index Scan using `nodes_embedding_idx`.
   - The eval seeds node ids derived from the node keys, so a reseeded corpus ties the same way.
   - A test checks that two reseeded runs rank identically.

9. **Lookups that borrow the hard words stay local** (after review). Each of these counts as hard only in the form shown:
   - **explain:** only "explain the difference / the trade-offs / how come".
   - **safe:** only in a judgement form: "safe to/under/for/when/if/with" or "is it safe".
   - **hold:** only "hold up" or "hold a" followed by a number.
   - **write down, update me, add up, make a list:** these never count; they are lookups.

Changes 1–6 each improved the metrics without regressing any. Changes 7 and 8 are kept as bug fixes despite the nomic top-1 change explained above. Change 9 fixes cloud routing for lookups at a measured cost of one held-out question.

## Privacy on the final pack

This came up in the same review. It is not measured by these evals; it is recorded here because it shares the routing code.

- **The bug:** in Auto, the privacy check ran on the local-sized pack (5 nodes). A hard question was then re-packed at the cloud budget (10 nodes) with no second check, so a private node ranked 6th to 10th went to the cloud.
- **The fix:** `routeAndPack` in `routing/route.js` checks the re-packed context again. A private node there forces local, or refuses when local is down, as one in the first pack always did. A continued conversation or prefilled draft that would resend a private node on a cloud route is rebuilt instead.
- **Tests:** `test/integration/privacyRepack.test.js` reproduces the leak and fails without the fix.

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
