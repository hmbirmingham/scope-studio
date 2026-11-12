---
id: e6-synth-report
use_case: code-feature
workspace: ~/vscode/systolic-array
branch: eval/e6-synth-report
difficulty: medium
---

## Task

`synth/reports/` is empty and the README's synthesis section says "not yet run".
Add the Yosys script and commit a report for `pe`.

Measured already, as a starting point to check yourself against: `synth_ice40`
on the PE gives 238 LUT4, 48 DFFESR and 41 SB_CARRY, with no `SB_MAC16`
inferred — the 8x8 multiply becomes LUT logic. Sixteen of those is roughly
3,800 LUTs.

A report committed by hand is worthless, so make it reproducible: the script
should regenerate the committed numbers, and the gate re-runs it.

## Gates

- script-added: files_changed synth
- rtl-untouched: files_untouched rtl
- report-reproducible: shell_passes scripts/synth-check.sh pe
- report-committed: files_changed synth/reports
- notes-no-hard-multiplier: must_match (?i)(SB_MAC16|hard multiplier|LUT logic)
