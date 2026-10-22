// The student demo's model, scripted: what a capable local model replies at
// each step of the demo tasks, so the end-to-end test and the runner tests
// walk the real engine (runner, approvals, OS sandbox, write-back) with no
// model at all. The reply is chosen from the prompt the runner sent, never
// from hidden state, so a reload, a retry or a resumed run gets the same one.
//
// "Check my lab report" plans, runs the analysis below in the OS sandbox
// (which asks for approval), saves the list of fixes and finishes. "Make a
// study guide" plans, saves the guide and finishes.

// Real analysis code: it runs in the sandbox and its output is computed, not
// scripted. The data are pendulum-data.csv from server/src/demo/content.js.
export const ANALYSIS_CODE = `const csv = \`0.20,9.04
0.20,8.94
0.20,9.01
0.40,12.64
0.40,12.76
0.40,12.67
0.60,15.59
0.60,15.49
0.60,15.60
0.80,17.92
0.80,18.03
0.80,17.88
1.00,20.12
1.00,20.05
1.00,20.13\`;
const rows = csv.split('\\n').map((line) => line.split(',').map(Number)).map(([L, t]) => ({ L, T: t / 10 }));
const n = rows.length;
const mx = rows.reduce((s, r) => s + r.L, 0) / n;
const my = rows.reduce((s, r) => s + r.T ** 2, 0) / n;
const sxx = rows.reduce((s, r) => s + (r.L - mx) ** 2, 0);
const slope = rows.reduce((s, r) => s + (r.L - mx) * (r.T ** 2 - my), 0) / sxx;
const intercept = my - slope * mx;
const resid = rows.reduce((s, r) => s + (r.T ** 2 - intercept - slope * r.L) ** 2, 0);
const slopeErr = Math.sqrt(resid / (n - 2) / sxx);
const g = (4 * Math.PI ** 2) / slope;
const gErr = (g * slopeErr) / slope;
const at = (L) => rows.filter((r) => r.L === L).reduce((s, r) => s + r.T, 0) / 3;
console.log(\`Fit of T² against L, all \${n} trials: slope = \${slope.toFixed(3)} ± \${slopeErr.toFixed(3)} s²/m\`);
console.log(\`g = 4π²/slope = \${g.toFixed(2)} ± \${gErr.toFixed(2)} m/s²\`);
console.log(\`Mean period at 0.80 m = \${at(0.8).toFixed(3)} s (the report says 1.556 s, the 0.60 m value: \${at(0.6).toFixed(3)} s)\`);
`;

export const LAB_PLAN = `1. Recompute g from pendulum-data.csv in the sandbox: fit T² against L through all 15 trials.
2. Compare the result, the table and the claims with the lab report draft and the handout's rubric.
3. Save a list of fixes to the map.`;

export const LAB_TITLE = 'Lab report check: what to fix before Friday';
export const LAB_FIXES = `1. Results table, 0.80 m row: the data give a mean period of 1.794 s, not 1.556 s (that is the 0.60 m value, copied). The point is not an outlier; put it back in the fit.
2. Slope and g: a least-squares fit of T² against L through all 15 trials gives 4.035 ± 0.016 s²/m, so g = 9.78 ± 0.04 m/s², 0.3% below 9.81 m/s². The report's 4.104 s²/m and 9.62 m/s² come from the copied row and a misread graph.
3. Uncertainty: ±0.01 m/s² is the stopwatch resolution only. Repeated trials scatter by about 0.05 s per 10 oscillations (reaction time; Taylor 1997, ch. 4), so quote the fit's ±0.04 m/s². The rubric gives 4 points for this.
4. Discussion: every trial was released from about 10°, so the data cannot show the period is independent of amplitude "at any angle". Lecture 8: at 30° the period is 1.7% longer (Nelson & Olsson 1986: T ≈ T₀(1 + θ₀²/16)).
5. Rubric: the handout asks for a best-fit line through all points and a references section; cite Taylor (1997) and Nelson & Olsson (1986).`;

export const LAB_SUMMARY = 'Recomputed g = 9.78 ± 0.04 m/s² from the data; the report’s 9.62 m/s² comes from a copied 0.80 m row and a misread slope. Five fixes saved to the map.';

export const GUIDE_PLAN = `1. Gather the key formulas and examples from lecture 7, lecture 8 and problem set 4.
2. Save a one-page study guide to the map.`;

export const GUIDE_TITLE = 'Study guide: oscillations (midterm)';
export const STUDY_GUIDE = `Key formulas
- SHM: F = −kx, ω = √(k/m) [rad/s], T = 2π/ω [s], E = ½kA² [J].
- Simple pendulum (small angles): ω = √(g/L), T = 2π√(L/g); independent of mass.
- T² against L is a straight line with slope 4π²/g.
Worked examples
- Spring: k = 20 N/m, m = 0.5 kg → ω = 6.3 rad/s, T = 1.0 s.
- Moon pendulum (PS4 Q3): L = 1.0 m, g = 1.62 m/s² → T = 2π√(1.0/1.62) = 4.9 s.
Common mistakes
1. Using degrees in sin θ ≈ θ (it needs radians).
2. Forgetting that the small-angle period is only good below about 10° (1.7% off at 30°).
3. Quoting the instrument resolution as the uncertainty instead of the spread of repeated trials.`;

export const GUIDE_SUMMARY = 'Saved a one-page oscillations study guide: formulas with units, two worked examples and three common mistakes.';

const choice = (capability, input, summary) => JSON.stringify({ capability, input, hard: false, done: false, summary });
const done = (summary) => JSON.stringify({ done: true, summary });

function promptParts(messages = []) {
  const system = messages.find((message) => message.role === 'system')?.content ?? '';
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  const step = Number(/This is step (\d+)\./.exec(user)?.[1] ?? 0);
  const goal = /Goal:\n([\s\S]*?)\n\n/.exec(user)?.[1] ?? '';
  return { system, user, step, goal };
}

// The reply text for one chat request, or null when the request is not part
// of the demo (the caller then answers as it otherwise would).
export function demoReply(messages) {
  const { system, step, goal } = promptParts(messages);
  const lab = /lab report/i.test(goal);
  const guide = /study guide/i.test(goal);
  if (!lab && !guide) return null;

  if (system.includes('You plan work')) return lab ? LAB_PLAN : GUIDE_PLAN;
  if (!system.includes('You choose the next single step')) return null;

  if (lab) {
    if (step <= 1) return choice('code.run_generated', { language: 'node', code: ANALYSIS_CODE }, 'Recompute g from the pendulum data with a least-squares fit');
    if (step === 2) return choice('graph.write_artifact', { title: LAB_TITLE, content: LAB_FIXES }, 'Save the list of fixes to the map');
    return done(LAB_SUMMARY);
  }
  if (step <= 1) return choice('graph.write_artifact', { title: GUIDE_TITLE, content: STUDY_GUIDE }, 'Save the study guide to the map');
  return done(GUIDE_SUMMARY);
}
