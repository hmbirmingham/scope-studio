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

`cad-bracket` is the CAD task's part, not a Node project: `bracket.stl`, an
80 × 20 × 5 mm plate with two 5 mm holes 40 mm apart, and `cad.json`
declaring millimetres. Its check measures the `bracket.stl` a run leaves
behind (hole spacing, wall, size) in JavaScript; nothing in it is executed.
The STL was exported by CadQuery from this source:

```python
length, width, thickness = 80, 20, 5
first, spacing, diameter = 15, 40, 5
plate = cq.Workplane("XY").box(length, width, thickness, centered=False)
result = plate.faces(">Z").workplane(origin=(0, 0, thickness)).pushPoints([(first, width / 2), (first + spacing, width / 2)]).hole(diameter)
cq.exporters.export(result, "bracket.stl", exportType="STL", tolerance=0.01, angularTolerance=0.1)
```

`physics-projectile` is not a Node project: it holds the statement of a
projectile-with-drag problem (`problem.json`, no answer), which the benchmark
ingests into the task's graph. Its check compares the computation the arm
produced with a reference value kept in the catalog, never in the fixture.

No code fixture has dependencies or touches the network; each runs with
`node --test` alone and is deterministic.

`research-harbor` is the research task's paper set rather than a project: a
reference library the benchmark ingests into the graph. Its own README gives
its provenance; it is CC0.

Provenance and licence: written for this benchmark, MIT.
