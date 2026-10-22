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

Retrieval figures are the mean of 5 runs. Most runs give identical numbers. The exception is lexical recall@1 after the change, which ranges from 70.2% to 73.4%; the cause is described under "Known gap". Baseline is `336f507`.

| Metric | Baseline | After |
|---|---|---|
| lexical recall@1 | 70.2% | 72.3% |
| lexical recall@5 | 89.4% | 92.6% |
| lexical recall@10 | 89.4% | 93.6% |
| lexical MRR | 0.816 | 0.851 |
| lexical coverage | 89.4% | 93.6% |
| lexical packed | 89.4% | 92.6% |
| nomic recall@1 | 78.4% | 79.4% |
| nomic recall@5 | 95.7% | 97.9% |
| nomic recall@10 | 96.0% | 98.1% |
| nomic MRR | 0.902 | 0.923 |
| nomic coverage | 96.8% | 98.9% |
| nomic packed | 95.7% | 97.9% |
| kicad group, lexical recall@5 | 65.4% | 76.9% |
| kicad group, nomic recall@5 | 88.5% | 96.2% |
| difficulty held-out: accuracy | 60.0% | 94.0% |
| difficulty held-out: hard precision / recall | 77.8% / 28.0% | 100% / 88.0% |
| difficulty sessions: accuracy | 91.9% | 100% |
| difficulty sessions: hard precision / recall | 97.3% / 80.0% | 100% / 100% |

Confusion matrices after the changes (rows are the actual label, columns the prediction):

```
held-out      easy  hard      sessions      easy  hard
  easy          25     0        easy          79     0
  hard           3    22        hard           0    45
```

## Changes kept

Each change below is its own commit. None of them made any metric worse.

1. **Change-verb requests:** a request that opens with fix/add/make/change/update/rename/remove/convert counts as hard.
2. **Drafting requests:** a request that opens with draft/write/compose counts as hard.
3. **Judgement questions:**
   - "is/does/will … safe/enough/race-free/hold up"
   - a request that opens with "should we"
   - "what would break/happen"
4. **Proposals, derivations, explanations and check runs:** a request that opens with suggest/propose/derive/explain, and "run a … check".
5. **Review and plan, narrowed:** these words now count only when they lead the request or act on an object. Before, "open peer review", "the review queue page" and "show me the plan for…" went to the cloud.
6. **Reference designators in lexical retrieval:** a two-character term that mixes a letter and a digit (C2, U1, J1) is now kept. Before, the query side dropped every term shorter than three characters, even though the index stores these as lexemes.

## Tried and reverted

- **Plural-to-singular matching in lexical retrieval** ("capacitors" also matching "capacitor"):
  - Nothing improved.
  - Lexical recall@1 fell from 72.3% to 70.6%, and the research group's recall@1 from 100% to 88.9%.
- **A bare leading "check … for" as hard:**
  - It routed "check the BOM for the part number of the MOSFET", a lookup, to the cloud.
  - I narrowed it to "run a … check". Measured at that step, held-out accuracy was 90.0% with the narrow form against 92.0% with the broad one: the narrow form misses one held-out question.
- **Making every node type rankable** (see "Known gap"):
  - What it does:
    - gives the 17 node types added by migrations 020 and 039 a recency rate, with a file-like fallback
    - gives the 8 newer relationship types an expansion weight, with a 0.5 fallback
    - maps the vertical types to the hardware and research task boosts
    - extends the hardware source boost to `cad`
  - Results on top of change 6:
    - unscored candidates fell from 177/210 to 0, and every run gave the same ranking
    - lexical MRR went from 0.851 to 0.849 and nomic recall@10 from 98.1% to 98.9%
    - nomic recall@1 dropped from 79.4% to 77.7%, and nomic MRR from 0.923 to 0.906
  - Under the keep-only-if-nothing-regresses rule it was reverted.
  - Partial variants were also worse on nomic recall@1 or MRR:
    - recency rates alone
    - recency rates plus task types
    - without the task types
    - with all run memory under the research boost, which also dropped code recall@5 to 88.9%

## Known gap

`DECAY_LAMBDA` in `retrieval/score.js` only lists the original seven node types. `EDGE_WEIGHTS` in `retrieval/retrieve.js` only lists the original five relationship types. As a result:

- Every schematic, symbol, net, footprint, BOM row, board, note, excerpt, derivation, computation, part, assembly, plan, step, finding, question and artifact node scores **NaN** whenever recency decay is on, which it is by default.
- So does anything reached over a `connects`, `implements`, `cites`, `contains`, `derived_from`, `produces`, `follows` or `answers` edge.
- `Array.prototype.sort` with a NaN comparator leaves these nodes wherever comparisons happen to put them. Their rank, and sometimes the order of their neighbours, is arbitrary and can change between runs. The "unscored" column measures this.

The baseline's good nomic top-1 numbers partly rely on this accident: NaN nodes tend to keep their dense-similarity order. The fix that gives them real scores also lets the task-type boost apply to them, and on this corpus that costs about one top-1 answer in 47. The patch is described above. Shipping it is a judgement call that the strict rule here does not make. It removes nondeterminism at the cost of a small measured top-1 loss.
