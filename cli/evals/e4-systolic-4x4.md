---
id: e4-systolic-4x4
use_case: code-feature
workspace: ~/vscode/systolic-array
branch: eval/e4-systolic-4x4
difficulty: hard
important: true
---

## Task

Write `rtl/systolic_4x4.sv`: sixteen `pe` cells wired as a 4x4
output-stationary array, per ADR-0001. `a` enters from the west, `b` from the
north, and each PE forwards what it received one cycle later, which is what
makes the diagonal wavefront arrive correctly.

Add `tb/array/` checking the array against `numpy.matmul` on randomised signed
4x4 inputs.

A flat combinational multiply would satisfy a test that only checks the numbers.
It would not be a systolic array. The gates below assert the structure and the
timing as well as the result, so build the pipeline the dataflow calls for and
let the latency be what it is — then say in the testbench what cycle the first
result is expected on, and why.

## Gates

- array-added: files_changed rtl/systolic_4x4.sv
- pe-untouched: files_untouched rtl/pe.sv
- oracle-untouched: files_untouched golden/pe_model.py
- instantiates-sixteen-cells: shell_passes scripts/count-instances.sh pe 16
- first-result-on-the-expected-cycle: shell_passes make -C tb/array LATENCY_CHECK=1
- array-suite-green: shell_passes make -C tb/array
- pe-suite-still-green: shell_passes make -C tb/pe
- synthesises: shell_passes scripts/synth-check.sh systolic_4x4
