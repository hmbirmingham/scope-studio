---
id: e5-im2col-bench
use_case: code-feature
workspace: ~/vscode/systolic-array
branch: eval/e5-im2col-bench
difficulty: hard
important: true
---

## Task

The second benchmark in the README: one convolution step from an
image-processing pipeline, expressed as a matmul via im2col, run on the array.

Build the im2col rearrangement and its own test first, separately from the
convolution reference — if the same code both builds the matrix and defines the
expected answer, the test proves only that the code agrees with itself. The
convolution reference should be `scipy`-free NumPy written directly from the
definition of a 2D convolution, not from the im2col form.

Report cycles for the array path. A number with no method stated is not a
measurement, so say what you counted and from which cycle.

## Gates

- bench-added: files_changed golden/im2col_model.py
- array-untouched: files_untouched rtl
- pe-oracle-untouched: files_untouched golden/pe_model.py
- model-tested: shell_passes .venv/bin/python -m pytest -q golden
- array-suite-green: shell_passes make -C tb/array
- states-the-method: must_match (?i)(cycles counted|measured from|counting from)
