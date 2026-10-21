import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The tasks the benchmark measures. A task is a fixture, instructions an
// agent is given, and an objective check that decides whether the task was
// completed: for code, the fixture's own test script passing in the result.
// What a model says about its own work never counts.
//
// `dry.actions` is the scripted work a dry run plays through both arms: the
// same capability calls, in the same order, so the arms differ only in how
// they carry context from one step to the next and what that costs. A real
// (live) run ignores it and lets the models choose.

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, 'fixtures');
// Kinds whose plug-in, verifiers and check exist; the rest are pending gates.
export const RUNNABLE_KINDS = ['code', 'physics'];

// The check puts these back from the pristine fixture before it runs, so a
// result that "passes" by editing the tests or the test script does not.
const RESTORE = ['test', 'package.json'];

const runTests = (summary) => ({ capability: 'code.run_script', input: { script: 'test' }, summary });
const read = (path, summary = `Read ${path}`) => ({ capability: 'code.read', input: { path }, summary });
const search = (query, summary = `Search for ${query}`) => ({ capability: 'code.search', input: { query }, summary });
const edit = (path, search, replace, summary) => ({ capability: 'code.edit', input: { path, search, replace }, summary });

// The dry run's computation for the projectile task: a terminal-event
// solve_ivp integration, cross-checked by a hand-written fixed-step RK4. It
// lives here, not in the fixture, so a live run's agent never sees it.
const PROJECTILE = Object.freeze({
  "title": "Baseball range with quadratic drag",
  "method": "solve_ivp with a terminal ground-crossing event",
  "code": "from scipy.integrate import solve_ivp\nk = (0.5 * rho * Cd * np.pi * r**2 / m).to('1/m').magnitude\ngg = g.to('m/s**2').magnitude\nspeed = v0.to('m/s').magnitude\nangle = theta.to('rad').magnitude\n\ndef rhs(s, y):\n    vx, vy = y[2], y[3]\n    v = np.hypot(vx, vy)\n    return [vx, vy, -k * v * vx, -gg - k * v * vy]\n\ndef ground(s, y):\n    return y[1]\nground.terminal = True\nground.direction = -1\nsol = solve_ivp(rhs, [0, 60], [0, 0, speed * np.cos(angle), speed * np.sin(angle)], events=ground, rtol=1e-10, atol=1e-10)\nresult = {'range': Q_(sol.y_events[0][0][0], 'm')}\n",
  "inputs": {
    "m": "0.145 kg",
    "r": "3.66 cm",
    "Cd": "0.47",
    "rho": "1.225 kg/m^3",
    "v0": "40 m/s",
    "theta": "35 deg",
    "g": "9.81 m/s^2"
  },
  "crossCheck": {
    "method": "a fixed-step fourth-order Runge-Kutta integration with linear interpolation of the landing point",
    "code": "k = (0.5 * rho * Cd * math.pi * r**2 / m).to('1/m').magnitude\ngg = g.to('m/s**2').magnitude\nspeed = v0.to('m/s').magnitude\nangle = theta.to('rad').magnitude\n\ndef f(state):\n    x, y, vx, vy = state\n    v = math.hypot(vx, vy)\n    return (vx, vy, -k * v * vx, -gg - k * v * vy)\n\ndef step(state, h):\n    a = f(state)\n    b = f([s + h / 2 * d for s, d in zip(state, a)])\n    c = f([s + h / 2 * d for s, d in zip(state, b)])\n    d4 = f([s + h * d for s, d in zip(state, c)])\n    return [s + h / 6 * (p + 2 * q + 2 * u + w) for s, p, q, u, w in zip(state, a, b, c, d4)]\n\nh = 1e-3\nstate = [0.0, 0.0, speed * math.cos(angle), speed * math.sin(angle)]\nwhile True:\n    nxt = step(state, h)\n    if nxt[1] < 0 and nxt[3] < 0:\n        frac = state[1] / (state[1] - nxt[1])\n        landing = state[0] + frac * (nxt[0] - state[0])\n        break\n    state = nxt\nresult = {'range': Q_(landing, 'm')}\n"
  }
});

export const TASKS = [
  {
    id: 'code-paginate-off-by-one',
    kind: 'code',
    status: 'ready',
    title: 'Every page drops its last row',
    bug: 'off-by-one',
    fixture: 'paginate',
    instructions:
      'Users report that every page of the admin table is missing its last row. Find the bug in this project and fix it so `npm test` passes. Do not change the tests.',
    check: { script: 'test', restore: RESTORE },
    dry: {
      plan: '1. Run the tests to reproduce.\n2. Find the paging code.\n3. Read it and the failing test.\n4. Fix the slice bounds.\n5. Run the tests again.',
      actions: [
        runTests('Reproduce the failing tests'),
        search('slice(', 'Find where a page is cut from the list'),
        read('src/paginate.js'),
        read('test/paginate.test.js', 'Read what the tests expect of a page'),
        edit('src/paginate.js', 'start + pageSize - 1', 'start + pageSize', 'slice end is exclusive, so a page ends at start + pageSize'),
        runTests('Confirm the tests pass'),
      ],
      summary: 'page() sliced one row short; the slice end is exclusive. Tests pass.',
    },
  },
  {
    id: 'code-invoice-wrong-operator',
    kind: 'code',
    status: 'ready',
    title: 'Invoices come out below their subtotal',
    bug: 'wrong operator',
    fixture: 'invoice',
    instructions:
      'An invoice with 20% tax totals less than its subtotal. Find the bug and fix it so `npm test` passes. Do not change the tests.',
    check: { script: 'test', restore: RESTORE },
    dry: {
      plan: '1. Run the tests.\n2. Read the invoice module.\n3. Fix the total.\n4. Run the tests again.',
      actions: [
        runTests('Reproduce the failing tests'),
        read('src/invoice.js'),
        read('test/invoice.test.js', 'Read the expected totals'),
        // A first attempt at the wrong place: the edit is made, its
        // verification fails, and the next attempt starts from that state.
        edit('src/invoice.js', 'Math.round(gross * (1 - discountRate))', 'Math.round(gross * (1 + discountRate))', 'Perhaps the discount sign is wrong'),
        runTests('Check the discount change'),
        edit('src/invoice.js', 'Math.round(gross * (1 + discountRate))', 'Math.round(gross * (1 - discountRate))', 'Undo the discount change: the line tests broke'),
        edit('src/invoice.js', 'return net - taxCents(net, taxRate);', 'return net + taxCents(net, taxRate);', 'Tax is added to the subtotal, not subtracted'),
        runTests('Confirm the tests pass'),
      ],
      summary: 'invoiceTotal subtracted tax; it now adds it. Tests pass.',
    },
  },
  {
    id: 'code-profile-missing-null-check',
    kind: 'code',
    status: 'ready',
    title: 'Profile card crashes for members without an address',
    bug: 'missing null check',
    fixture: 'profile-card',
    instructions:
      'The profile card throws for early members who have no address on file. Make it show "Location unknown" for them instead, so `npm test` passes. Do not change the tests.',
    check: { script: 'test', restore: RESTORE },
    dry: {
      plan: '1. Run the tests.\n2. Find where the address is read.\n3. Guard the missing address.\n4. Run the tests again.',
      actions: [
        runTests('Reproduce the crash'),
        search('user.address', 'Find where the address is read'),
        read('src/profile.js'),
        edit('src/profile.js', 'const { city, country } = user.address;', 'const { city, country } = user.address ?? {};', 'A member may have no address at all'),
        runTests('Confirm the tests pass'),
      ],
      summary: 'location() destructured a missing address; it now treats a missing address as empty. Tests pass.',
    },
  },
  {
    id: 'code-temperature-wrong-import',
    kind: 'code',
    status: 'ready',
    title: 'Daily mean temperature is wrong',
    bug: 'wrong import',
    fixture: 'temperature-report',
    instructions:
      'The daily report shows a mean temperature that does not match the readings. Find the bug and fix it so `npm test` passes. Do not change the tests.',
    check: { script: 'test', restore: RESTORE },
    dry: {
      plan: '1. Run the tests.\n2. Read the report and both stats modules.\n3. Import the right average.\n4. Run the tests again.',
      actions: [
        runTests('Reproduce the wrong mean'),
        read('src/report.js'),
        search('export function average', 'Find every average the project defines'),
        read('src/stats/smoothing.js', 'Read the smoothing average'),
        read('src/stats/mean.js', 'Read the summary statistics'),
        edit(
          'src/report.js',
          "import { range } from './stats/mean.js';\nimport { average } from './stats/smoothing.js';",
          "import { average, range } from './stats/mean.js';",
          'The report needs the arithmetic mean, not the chart smoothing'
        ),
        runTests('Confirm the tests pass'),
      ],
      summary: 'report.js imported the smoothing average; it now uses the arithmetic mean from stats/mean.js. Tests pass.',
    },
  },
  {
    id: 'code-batch-async-ordering',
    kind: 'code',
    status: 'ready',
    title: 'Batch jobs overlap and results go missing',
    bug: 'async ordering',
    fixture: 'batch-queue',
    instructions:
      'runInOrder is supposed to run jobs one at a time and return every result in order, but it returns early and the jobs overlap. Fix it so `npm test` passes. Do not change the tests.',
    check: { script: 'test', restore: RESTORE },
    dry: {
      plan: '1. Run the tests.\n2. Read the batch module and its tests.\n3. Await each job in turn.\n4. Run the tests again.',
      actions: [
        runTests('Reproduce the early return'),
        read('src/batch.js'),
        read('test/batch.test.js', 'Read how overlap is detected'),
        search('forEach(async', 'Look for other async forEach loops'),
        edit(
          'src/batch.js',
          '  items.forEach(async (item) => {\n    results.push(await job(item));\n  });',
          '  for (const item of items) {\n    results.push(await job(item));\n  }',
          'forEach does not wait for async callbacks; a for…of loop awaits each job'
        ),
        runTests('Confirm the tests pass'),
      ],
      summary: 'runInOrder used forEach with an async callback, which neither waits nor serialises; a for…of loop does both. Tests pass.',
    },
  },

  {
    // The longest of the code tasks: the bug sits two modules away from the
    // symptom, so the work is mostly reading, which is where a transcript
    // grows and a graph slice does not.
    id: 'code-order-quote-unit-mismatch',
    kind: 'code',
    status: 'ready',
    title: 'Every quote charges the heaviest shipping band',
    bug: 'unit mismatch',
    fixture: 'order-quote',
    instructions:
      'Customers are quoted overweight shipping on light orders. Find out why and fix it so `npm test` passes. Do not change the tests.',
    check: { script: 'test', restore: RESTORE },
    dry: {
      plan: '1. Run the tests.\n2. Trace a quote from quote.js into shipping.\n3. Check the weight units.\n4. Fix the conversion.\n5. Rule out the other modules and run the tests again.',
      actions: [
        runTests('Reproduce the wrong shipping'),
        read('src/quote.js', 'Trace how a quote is built'),
        read('src/shipping.js', 'Read the shipping bands'),
        read('test/quote.test.js', 'Read the expected shipping'),
        search('totalGrams', 'Find where the parcel weight comes from'),
        read('src/weight.js'),
        {
          capability: 'code.run_generated',
          input: { language: 'node', code: 'const grams = 2 * 300 + 50 + 250;\nconsole.log(JSON.stringify({ grams, kg: grams / 1000 }));\n' },
          summary: 'Work out the first test order’s weight in grams and kilograms',
        },
        read('src/price.js', 'Rule out the pricing'),
        search('kg', 'Find every place that expects kilograms'),
        edit('src/shipping.js', 'const kg = totalGrams(items);', 'const kg = totalGrams(items) / 1000;', 'totalGrams returns grams; the bands are in kilograms'),
        runTests('Check the fix'),
        read('src/parse.js', 'Confirm the export gives grams'),
        search('gramsEach', 'Check nothing else treats grams as kilograms'),
        runTests('Confirm the tests pass'),
      ],
      summary: 'shippingCents passed grams to bands priced in kilograms; it now converts. Tests pass.',
    },
  },

  // Acceptance gates for the verticals still being built. They are listed in
  // every report as pending, never run and never counted as failures; each
  // says what makes it ready.
  {
    id: 'kicad-erc-unconnected-pin',
    kind: 'kicad',
    status: 'pending',
    title: 'Fix an ERC error in a sensor board schematic',
    instructions: 'The schematic fails ERC with an unconnected input pin on the ADC. Connect it as the datasheet intends and leave ERC clean.',
    fixture: { kind: 'KiCad 8 project', description: 'a small sensor board with one ERC error' },
    check: { description: 'kicad-cli sch erc reports zero errors on the result, and the netlist differs from the original only on the ADC pin' },
    pending: {
      reason: 'no KiCad plug-in is registered yet, so no agent can read or edit a schematic',
      readyWhen: 'the KiCad plug-in registers schematic read/edit capabilities and a kicad.erc verifier that runs kicad-cli in the OS sandbox',
    },
  },
  {
    id: 'research-cited-summary',
    kind: 'research',
    status: 'pending',
    title: 'Answer a question from a fixed paper set, with citations',
    instructions: 'Using only the papers in the project, state which method has the lowest reported error on the benchmark and cite the table it comes from.',
    fixture: { kind: 'paper set', description: 'five open-licence papers ingested as nodes, one of which holds the answer' },
    check: { description: 'the named method and the cited paper and table match the answer key, and every citation resolves to an ingested node' },
    pending: {
      reason: 'no research plug-in is registered yet, so there is no citation capability or citation verifier',
      readyWhen: 'the research plug-in registers a cited-answer capability and a research.citations verifier that resolves every citation to a node',
    },
  },
  {
    id: 'physics-projectile-range',
    kind: 'physics',
    status: 'ready',
    title: 'Compute a projectile range with drag, units checked',
    role: 'physicist',
    fixture: 'physics-projectile',
    problem: 'problem.json',
    instructions:
      'Compute the range of the projectile described in the project notes, with quadratic drag, to three significant figures, in metres. Cross-check it with an independent method.',
    check: {
      kind: 'quantity',
      capability: 'physics.compute',
      output: 'range',
      units: 'm',
      // Computed independently with SciPy's solve_ivp (rtol and atol 1e-12);
      // see fixtures/physics-projectile/README.md.
      reference: 84.65925243092497,
      rtol: 0.005,
      description: 'a physics.compute result that passed its units and cross-check verifiers, in metres, within 0.5% of the reference',
    },
    dry: {
      plan: '1. Read the problem.\n2. Integrate the equations of motion with quadratic drag, cross-checked by a second integrator.\n3. Report the range in metres.',
      actions: [
        {
          capability: 'physics.compute',
          input: {
            title: PROJECTILE.title,
            method: PROJECTILE.method,
            code: PROJECTILE.code,
            outputs: { range: 'm' },
            inputs: PROJECTILE.inputs,
            crossCheck: PROJECTILE.crossCheck,
          },
          summary: 'Integrate the trajectory with drag and cross-check it with a fixed-step RK4',
        },
      ],
      summary: 'The range with quadratic drag is 84.7 m, cross-checked by two integrators.',
    },
  },
  {
    id: 'cad-bracket-hole-spacing',
    kind: 'cad',
    status: 'pending',
    title: 'Move a bracket’s mounting holes to a new spacing',
    instructions: 'Change the bracket’s mounting hole spacing from 40 mm to 50 mm and keep 4 mm of material around each hole.',
    fixture: { kind: 'parametric part', description: 'a bracket with two mounting holes' },
    check: { description: 'the regenerated part measures 50 mm between hole centres and at least 4 mm of wall around each hole' },
    pending: {
      reason: 'no CAD plug-in is registered yet, so no agent can edit or measure a part',
      readyWhen: 'the CAD plug-in registers parametric edit and measure capabilities and a cad.geometry verifier that measures the regenerated part',
    },
  },
];

// Problems with a task definition, so a broken catalog fails before any arm
// runs rather than half way through a paid run.
export function validateTask(task) {
  const problems = [];
  if (typeof task?.id !== 'string' || !/^[a-z0-9-]+$/.test(task.id)) problems.push('id must be lowercase words joined by dashes');
  if (!['ready', 'pending'].includes(task?.status)) problems.push('status must be ready or pending');
  if (typeof task?.instructions !== 'string' || !task.instructions.trim()) problems.push('instructions are required');
  if (task?.status === 'pending') {
    if (!task.pending?.reason || !task.pending?.readyWhen) problems.push('a pending task says why it is pending and what makes it ready');
    return problems;
  }
  if (!RUNNABLE_KINDS.includes(task.kind)) problems.push(`only ${RUNNABLE_KINDS.join(' and ')} tasks can run so far, not ${task.kind}`);
  const dir = typeof task.fixture === 'string' ? join(FIXTURES_DIR, task.fixture) : null;
  if (task.kind === 'physics') {
    if (!dir || typeof task.problem !== 'string' || !existsSync(join(dir, task.problem))) problems.push(`fixture ${task.fixture} has no problem statement`);
    const check = task.check ?? {};
    if (check.kind !== 'quantity' || typeof check.capability !== 'string' || typeof check.output !== 'string' || typeof check.units !== 'string' || !Number.isFinite(check.reference) || !(check.rtol > 0)) {
      problems.push('a physics task checks a quantity: capability, output, units, reference and rtol');
    }
  } else {
    if (!dir || !existsSync(join(dir, 'package.json')) || !statSync(dir).isDirectory()) problems.push(`fixture ${task.fixture} is missing`);
    if (typeof task.check?.script !== 'string') problems.push('a code task names the script its check runs');
  }
  if (!Array.isArray(task.dry?.actions) || task.dry.actions.length === 0) problems.push('a ready task scripts its dry run');
  for (const action of task.dry?.actions ?? []) {
    if (typeof action?.capability !== 'string' || !action.input || typeof action.input !== 'object') problems.push('every dry action names a capability and an input');
  }
  return problems;
}

// A physics task's problem statement, which the arms are given (the Scope
// arm through its graph, the baseline in its first message).
export function problemOf(task) {
  return JSON.parse(readFileSync(join(fixturePath(task), task.problem), 'utf8'));
}

export function fixturePath(task) {
  return join(FIXTURES_DIR, task.fixture);
}

export function selectTasks(tasks, { ids = null, kinds = null } = {}) {
  return tasks.filter((task) => (!ids || ids.includes(task.id)) && (!kinds || kinds.includes(task.kind)));
}
