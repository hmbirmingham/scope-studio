# Task benchmark fixtures

Small Node projects, each with one real-looking bug that makes its own test
script fail. The task benchmark (`npm run benchmark:tasks`) copies a fixture
into a throwaway git repository, lets each arm try to fix it, and counts the
task as completed only if `npm test` passes in the result, with the fixture's
original tests and `package.json` put back first.

| Fixture | Bug |
|---|---|
| `paginate` | Off-by-one: a page slice drops its last row. |
| `invoice` | Wrong operator: tax is subtracted from the subtotal. |
| `profile-card` | Missing null check: a member with no address crashes the card. |
| `temperature-report` | Wrong import: the report averages with the chart's smoothing function. |
| `batch-queue` | Async ordering: `forEach(async …)` returns before the jobs finish and runs them all at once. |
| `order-quote` | Unit mismatch: shipping bands priced in kilograms are given grams, two modules from the symptom. |

`physics-projectile` is not a Node project: it holds the statement of a
projectile-with-drag problem (`problem.json`, no answer), which the benchmark
ingests into the task's graph. Its check compares the computation the arm
produced with a reference value kept in the catalog, never in the fixture.

No code fixture has dependencies or touches the network; each runs with
`node --test` alone and is deterministic.

Provenance and licence: written for this benchmark, MIT.
