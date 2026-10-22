// The demo's student project: one week of an intro physics course, the kind
// of material a first-year student actually has on their laptop. The lab
// report draft contains real mistakes (a row copied from the wrong length, a
// misread slope, an uncertainty that ignores reaction time, a claim the data
// cannot support), so "check my report against the data" has something true
// to find. A least-squares fit of the data gives g = 9.78 ± 0.04 m/s².
//
// Every node's first line is its title: the map labels a node with it.

export const DEMO_PROJECT = 'PHYS 101 Pendulum Lab';
export const DEMO_EMAIL = 'student@scope-demo.local';
// Nodes the seed writes carry this prefix in external_id, so a re-seed
// replaces exactly them.
export const EXTERNAL_PREFIX = 'scope-demo/';

export const DEMO_NODES = [
  {
    key: 'lab-report',
    type: 'file',
    privacy: 'cloud',
    content: `Lab report draft: Measuring g with a simple pendulum
lab-report-draft.md · due Friday

Aim: measure the gravitational acceleration g from the period of a simple pendulum, T = 2π√(L/g).

Method: a 50 g bob on a light string, released from about 10°. For each length L we timed 10 oscillations three times with a phone stopwatch (resolution 0.01 s) and divided by 10.

Results (mean period per length):
| L (m) | mean T (s) |
| 0.20 | 0.900 |
| 0.40 | 1.269 |
| 0.60 | 1.556 |
| 0.80 | 1.556 |
| 1.00 | 2.010 |

The 0.80 m point does not fit the trend, so we treated it as an outlier and left it out of the fit.
From the graph of T² against L we read a slope of 4.104 s²/m, so g = 4π²/slope = 9.62 m/s².
Uncertainty: the stopwatch reads to 0.01 s, so g = 9.62 ± 0.01 m/s², 1.9% below the accepted 9.81 m/s².

Discussion: our result shows that the period of a pendulum does not depend on the amplitude at any angle, only on its length.`,
  },
  {
    key: 'data',
    type: 'file',
    privacy: 'cloud',
    content: `Raw data: pendulum-data.csv
length_m,trial,time_10_osc_s
0.20,1,9.04
0.20,2,8.94
0.20,3,9.01
0.40,1,12.64
0.40,2,12.76
0.40,3,12.67
0.60,1,15.59
0.60,2,15.49
0.60,3,15.60
0.80,1,17.92
0.80,2,18.03
0.80,3,17.88
1.00,1,20.12
1.00,2,20.05
1.00,3,20.13`,
  },
  {
    key: 'handout',
    type: 'spec',
    privacy: 'cloud',
    content: `Lab 3 handout: The simple pendulum (rubric)
Keep the release angle below 10° so the small-angle approximation holds.
Time at least 10 oscillations per trial and repeat each length three times.
Rubric: data table with units (4 pts); T² vs L graph with a best-fit line through all points (4 pts);
g with an uncertainty from the spread of your trials, not just the instrument (4 pts);
discussion of assumptions and sources of error (4 pts); references (2 pts).`,
  },
  {
    key: 'lecture-7',
    type: 'note',
    privacy: 'cloud',
    content: `Lecture 7 notes: Simple harmonic motion
SHM: restoring force proportional to displacement, F = −kx, so x(t) = A cos(ωt + φ) with ω = √(k/m).
Period T = 2π/ω, frequency f = 1/T. Energy swaps between kinetic and potential: E = ½kA².
Velocity is largest at x = 0, acceleration largest at the turning points.
Example: mass on a spring, k = 20 N/m, m = 0.5 kg → ω = 6.3 rad/s, T = 1.0 s.
Prof said the midterm always has one "find T from a graph" question.`,
  },
  {
    key: 'lecture-8',
    type: 'note',
    privacy: 'cloud',
    content: `Lecture 8 notes: Pendulums and the small-angle approximation
Simple pendulum: torque −mgL sin θ. For small θ, sin θ ≈ θ (in radians), which turns it into SHM with ω = √(g/L).
So T = 2π√(L/g): independent of mass and, only for small angles, of amplitude.
At 10° the exact period is 0.2% longer than 2π√(L/g); at 30° it is 1.7% longer.
Plot T² against L: a straight line through the origin with slope 4π²/g.
Physical pendulum: T = 2π√(I/(m g d)).`,
  },
  {
    key: 'problem-set',
    type: 'spec',
    privacy: 'cloud',
    content: `Problem set 4: Oscillations (due next Wednesday)
1. A 0.25 kg mass on a spring oscillates with T = 0.80 s. Find k.
2. A pendulum clock runs slow. Should you lengthen or shorten the pendulum? By what fraction to gain 1 minute per day?
3. Derive the period of a pendulum on the Moon (g = 1.62 m/s²) for L = 1.0 m.
4. From a T² vs L graph with slope 4.00 s²/m, find g and its uncertainty if the slope is ±0.05 s²/m.
5. Why does the small-angle approximation fail at 45°? Estimate the error.`,
  },
  {
    key: 'nelson-olsson',
    type: 'paper',
    privacy: 'cloud',
    content: `Nelson & Olsson (1986): The pendulum — rich physics from a simple system
R. A. Nelson and M. G. Olsson, American Journal of Physics 54, 112–121 (1986).
Corrections a precise pendulum measurement of g has to make: finite amplitude, the bob's size (physical pendulum),
string mass and stretch, air buoyancy and drag. The finite-amplitude correction is T ≈ T₀(1 + θ₀²/16).`,
  },
  {
    key: 'taylor',
    type: 'paper',
    privacy: 'cloud',
    content: `Taylor (1997): An Introduction to Error Analysis
J. R. Taylor, An Introduction to Error Analysis, 2nd ed., University Science Books (1997).
Ch. 4: when repeated measurements scatter more than the instrument's resolution, the standard deviation of the mean is the uncertainty.
Hand-timing reaction error is typically 0.1–0.2 s per start/stop, which is why you time many oscillations.`,
  },
  {
    key: 'private-journal',
    type: 'note',
    privacy: 'local',
    content: `Private: my study log and grades
Lab 2 grade: 13/18. TA comment: "uncertainty analysis too thin, cite your sources".
Midterm in 12 days. Weak spots: uncertainty propagation, reading slopes off graphs.
Plan: office hours Tuesday; redo problem set 3 Q4; finish the lab report by Thursday night.`,
  },
];

// How the material is connected, as the student would link it.
export const DEMO_RELATIONSHIPS = [
  ['lab-report', 'data', 'references'],
  ['lab-report', 'handout', 'references'],
  ['lab-report', 'nelson-olsson', 'cites'],
  ['lab-report', 'taylor', 'cites'],
  ['data', 'handout', 'part_of'],
  ['lecture-8', 'lecture-7', 'references'],
  ['handout', 'lecture-8', 'references'],
  ['problem-set', 'lecture-7', 'references'],
  ['problem-set', 'lecture-8', 'references'],
  ['private-journal', 'lab-report', 'references'],
];

export const DEMO_AGENT = {
  name: 'Lab Partner',
  template: 'physicist',
  // The Physicist template's tags without `physics`. The physics plug-in's
  // capabilities run Python with NumPy, SciPy and Pint in the sandbox, which a
  // student's laptop usually lacks, and a real 8B model offered them spent
  // three failed steps on physics.check before going back to the plan. With
  // `graph` and `sandbox` it sees exactly what the lab check needs. The tag
  // can be ticked back on in the agent builder (docs/demo.md).
  tags: ['graph', 'sandbox'],
  level: 'supervised',
  modelPolicy: 'local_only',
  color: '#3e63dd',
};

export const CHECK_REPORT_TASK = 'Check my lab report against the data';
export const STUDY_GUIDE_TASK = 'Make a study guide from my lecture notes';
export const WEEKLY_TASK = 'Weekly study guide';

export const DEMO_TASKS = [
  {
    title: CHECK_REPORT_TASK,
    // Written the way a student would after a first try: a small local model
    // follows a short, explicit recipe far more reliably than an open goal,
    // and the data are in the map, not in a file the sandbox could open.
    // A step's whole reply (code included, escaped inside JSON) has to fit
    // the runner's per-step output limit, so the code is asked to be short.
    instructions:
      'Recompute g from pendulum-data.csv and check my lab report against it, in three steps. Keep the plan to three one-line steps, with no code in it. ' +
      '1) One code step with language "node": plain JavaScript, no libraries, no plots, under 20 lines. Write the 15 rows of the CSV into the code ' +
      '(there is no file to open), take T = time for 10 oscillations / 10, fit T² against L through all 15 trials by least squares, and print the slope, ' +
      'g = 4π²/slope and the mean T at each length. ' +
      '2) Compare that with my lab report draft and the handout’s rubric, and save one short list of every number or claim to fix with graph.write_artifact. ' +
      '3) Once that list is saved the task is complete: do not run the code again, reply done with a one-sentence summary.',
    schedule: null,
  },
  {
    title: STUDY_GUIDE_TASK,
    instructions:
      'Make a one-page study guide for the midterm from my lecture 7 and 8 notes and problem set 4: key formulas with units, ' +
      'one worked example each, and the three mistakes students make most often. Save it with graph.write_artifact in one step, then finish.',
    schedule: null,
  },
  {
    title: WEEKLY_TASK,
    instructions: 'Every Sunday, update my study guide with anything new from this week’s lecture notes and problem sets, and save it to the map.',
    // Sundays at 18:00 UTC.
    schedule: '0 18 * * 0',
  },
];
