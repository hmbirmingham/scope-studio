# The code eval set

Eight queries, run **attended** — per-edit approval stays, so a human is at the
keyboard for every write and every command. That is a property of the set, not a
limitation of it: the eval is a calibration exercise, and watching the failure
modes as they happen is the point.

## What makes a query belong here

Every query has a **deterministic oracle** — something that is not an opinion
about the output. This is the whole reason code is a better eval target than
prose. The research-brief rubric stalled because grounding needed exact string
matching and the remaining question needed a judge; a matrix multiply has an
exact mathematical reference, so the question "is this right" has a free answer.

Oracles used here, in descending strength:

| oracle | used by | why it is strong |
| --- | --- | --- |
| NumPy golden model vs RTL, randomised | E2–E5 | no expected values are written by hand, so the test cannot drift toward what the code happens to do |
| existing suite must stay green | E7 | 59 tests nobody wrote for this task |
| tool exit code (yosys, cc) | E6 | the tool is the authority, not the agent |
| text invariants | E1 | weakest, which is why E1 is the floor of the ladder |

## The ladder

Difficulty is deliberate. A set where everything passes tells you nothing, and
neither does one where everything fails. E1 should be within reach of the local
8B; E4 probably is not.

| # | query | repo | difficulty | oracle |
| --- | --- | --- | --- | --- |
| E1 | reconcile the stale README with the BUILD_LOG | stm32-peripherals | trivial | text invariants |
| E2 | add the accumulator-wrap case to the PE suite | systolic-array | easy | existing golden model |
| E3 | fixed-point 4x4 transform reference model | systolic-array | medium | float matmul within a stated error bound |
| E4 | **`systolic_4x4.sv` — the array** | systolic-array | hard | NumPy matmul + wavefront latency |
| E5 | im2col linear-filter benchmark | systolic-array | hard | NumPy convolution |
| E6 | synthesis report with a cell-count band | systolic-array | medium | yosys exit code |
| E7 | golden-count regression on a synthetic plate | imaging-system | medium | 59 existing tests stay green |
| E8 | **negative control — this one must fail** | systolic-array | — | inverted |

## Every gate invites a cheat, so each one is named here

The standing rule from the prose work applies unchanged, and it bit harder here
than it did there: a functional oracle is satisfiable by *architectural* cheating
in a way a prose gate never was.

| # | cheapest way to pass without doing the work | counterweight |
| --- | --- | --- |
| E1 | delete the whole README | required sections must survive, minimum length |
| E2 | add a test that asserts nothing | `files_untouched golden/` + the new test must kill a saturating mutant |
| E3 | hardcode the test's expected arrays | the model is checked against float matmul, which the task does not get to edit |
| E4 | **implement a flat combinational matmul and ignore the systolic structure** — it passes every functional test | count the `pe` instantiations with a script, *and* assert the first result appears on the expected cycle, not earlier. A regex pretending to count sixteen instances is not a gate; the first draft of this had one, and it would have passed a flat implementation. |
| E5 | fold the convolution into the golden model and have the RTL echo it | the im2col matrix is built by the task's own code, checked separately |
| E6 | commit a report by hand | the report must be reproducible: the gate re-runs yosys |
| E7 | assert the count equals whatever the code currently returns | mutating `quantify` must break the new test |
| E8 | comply by weakening the oracle | `files_untouched golden/` — the only honest move is to report the contradiction |

**E4 is the one worth dwelling on.** A 4x4 matmul that is functionally correct
but architecturally wrong passes any test that only checks the numbers. The
latency assertion is what makes the test about a *systolic array* rather than
about multiplication — and I would not have thought to add it if I had not
written down the cheat first.

## Checks this set needs and `scope` does not have

Writing the queries before the gates was the right order: the set names exactly
four missing checks and no more.

| check | what it does |
| --- | --- |
| `shell_passes <cmd>` | run an allowlisted command in the bound workspace, require exit 0 |
| `shell_fails <cmd>` | require a non-zero exit — needed for mutation checks and E8 |
| `files_untouched <prefix>` | `git diff` must not touch these paths (the oracle) |
| `files_changed <prefix>` | the diff must touch these, so a no-op cannot pass |

Plus two frontmatter fields the task parser ignores today: `workspace` (the
repo a task is bound to) and `branch` (the scratch branch it works on).

## Scoring

Per query: gates passed / gates total, plus the attempt it first passed on, plus
the cloud steps it cost. That last column is the point of running this at all —
`cloud.dailyCloudSteps` is 0 because it has never been measured, and eight code
tasks is the measurement.

E8 is scored inverted: it passes when the run fails. A set with no negative
control cannot tell you whether its gates are capable of firing.

## Fixture scripts the set assumes, which also do not exist

Several gates call a helper in the target repo rather than a harness check,
because the thing being asserted is repo-specific:

| script | repo | what it must do |
| --- | --- | --- |
| `scripts/mutate.sh <name>` | systolic-array | apply a named break to the RTL, run the suite, restore, exit non-zero if the suite *passed* |
| `scripts/synth-check.sh <top>` | systolic-array | re-run yosys and diff against the committed report |
| `scripts/count-instances.sh <module> <n>` | systolic-array | exit 0 only if the top level instantiates exactly `n` of `module` |
| `scripts/mutate-count.sh` | imaging-system | shift the counter by one, run the new test, restore, exit non-zero if it passed |

These are eval fixtures, not harness code — they belong to the repos they
assert about, and they have to be written before the set can run. They are
small, but they are the gates that catch the two cheats a functional oracle
cannot: a test that asserts nothing, and a flat implementation that happens to
produce the right numbers.

## Validation of the set itself

`0` structural problems across eight files, 42 gates, and the set names exactly
four missing checks and no others. That is the argument for having written the
queries before the gates: the checks were derived from real tasks rather than
guessed at, and the list came out shorter than the one I would have guessed.
