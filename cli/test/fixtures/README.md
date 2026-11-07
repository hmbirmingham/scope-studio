# Selection regression fixtures

Snapshots of the two pages in `scope/tasks/retrieval-metrics-brief.md`, captured
**2026-11-07** through `runners/fetch.js` (so the text is exactly what a run
sees, markdown headings and all — not raw HTML, and not hand-cleaned).

| file | source | note |
| --- | --- | --- |
| `dcg.txt` | `en.wikipedia.org/wiki/Discounted_cumulative_gain` | whole page |
| `precision-recall.txt` | `en.wikipedia.org/wiki/Precision_and_recall` | truncated at the fetcher's 40,000-char ceiling, as a real run truncates it |

They are snapshotted rather than fetched because a test that reaches the network
is not a regression test: it fails when the connection does, and it silently
changes meaning when somebody edits an article.

Together they come to ~13,500 estimated tokens against an 8,192-token window —
the case that `scope run` used to refuse outright, and the reason the selection
layer exists. Re-capture them only on purpose: the assertions in
`regression.selection.test.js` name specific sentences a correct brief has to be
able to cite, and replacing the snapshots can invalidate those without any code
having changed.

`retrieval-metrics-brief.md` is a pinned copy of the task itself, so the test
reads the real question and gate set rather than a constant that would go stale
the moment the vault copy is edited. The live task stays in the vault at
`scope/tasks/retrieval-metrics-brief.md`; this copy is what the suite runs
against. If you change the question there, copy it here on purpose — and expect
the citable-sentence assertions to need revisiting, since they are the sentences
*that* question's answer has to reach for.
