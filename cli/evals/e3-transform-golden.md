---
id: e3-transform-golden
use_case: code-feature
workspace: ~/vscode/systolic-array
branch: eval/e3-transform-golden
difficulty: medium
---

## Task

Write `golden/transform_model.py`: the NumPy reference for the 3D-transform
benchmark the README describes — a 4x4 homogeneous transform applied to a point
cloud batched as 4xN tiles, in fixed point at DATA_W=16.

This model becomes the oracle for the RTL benchmark later, so an error here
would not fail — it would silently become the definition of correct. Treat that
as the main risk. State the fixed-point format you chose and the error bound it
implies against float arithmetic, and test the model against float matmul within
that bound rather than against values you wrote down.

## Gates

- model-added: files_changed golden/transform_model.py
- rtl-untouched: files_untouched rtl
- model-tested: shell_passes .venv/bin/python -m pytest -q golden
- states-the-format: must_match (?i)(Q[0-9]+\.[0-9]+|fixed.point format|scale factor)
- states-the-bound: must_match (?i)error bound
