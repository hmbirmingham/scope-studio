---
id: e7-imaging-golden-count
use_case: code-feature
workspace: ~/vscode/imaging-system
branch: eval/e7-imaging-golden-count
difficulty: medium
---

## Task

The suite has 59 tests and a synthetic-plate generator in
`testing/continuous/synthetic_data.py`. Nothing pins the counter's output: a
change to `quantify.py` that shifts every count by one would pass today.

Add a golden-count regression — a fixed synthetic plate with a fixed seed, and
an assertion on the count the current code produces. Read the generator before
you choose the plate, and say in the test why that plate is a reasonable one to
pin rather than an arbitrary one.

Pinning current behaviour is only useful if the current behaviour is right.
If reading `quantify.py` makes you doubt the count you are about to freeze, say
so in the test's docstring instead of freezing it quietly.

## Gates

- test-added: files_changed tests
- source-untouched: files_untouched quantify.py anomaly.py imager.py
- suite-green: shell_passes .venv/bin/python -m pytest -q
- catches-an-off-by-one: shell_fails scripts/mutate-count.sh
- justifies-the-plate: must_match (?i)(seed|deterministic|fixed plate)
