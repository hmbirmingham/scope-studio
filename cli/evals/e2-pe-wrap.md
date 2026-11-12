---
id: e2-pe-wrap
use_case: code-feature
workspace: ~/vscode/systolic-array
branch: eval/e2-pe-wrap
difficulty: easy
---

## Task

The PE accumulator is a fixed-width register, so it wraps rather than
saturating, and `golden/pe_model.py` already models that with `wrap_signed`.
Nothing in `tb/pe/test_pe.py` exercises it: every existing case stays well
inside 32 bits.

Add a case that drives the accumulator past ACC_W and checks the RTL against the
model through the wrap. Do not change the model — if the RTL and the model
disagree, say which one you believe and why rather than editing the oracle.

## Gates

- oracle-untouched: files_untouched golden
- rtl-untouched: files_untouched rtl
- test-changed: files_changed tb/pe/test_pe.py
- suite-green: shell_passes make -C tb/pe
- catches-saturation: shell_fails scripts/mutate.sh saturate
