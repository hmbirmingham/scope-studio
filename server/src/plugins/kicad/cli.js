import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createScratchSandbox, removeSandbox } from '../../workspace/sandbox/checkout.js';
import { findExecutable } from '../../workspace/sandbox/run.js';
import { checkoutRoot, resolveInside } from '../code/paths.js';
import { chooseDesign, listKicadFiles, loadSchematic, readDesignFile, rootSchematics } from './files.js';
import { KicadError } from './sexpr.js';

// ERC and DRC through KiCad's own command-line tool. kicad-cli gained
// `sch erc` and `pcb drc` in KiCad 8, so an older kicad-cli counts as
// missing. The checks never run on the host: the design's files are copied
// into a private scratch directory and kicad-cli runs on that copy inside the
// OS sandbox (no network, nothing else writable), whether the files came
// from the user's folder or from the run's sandbox copy, which a model may
// have edited.
//
// Without kicad-cli a verifier says so ({ ok: true, unavailable: true }),
// never a pass it did not check; without an OS sandbox it does not run the
// tool at all and the result is unverified ({ ok: false, unverified: true }).

const MIN_MAJOR = 8;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_LISTED_VIOLATIONS = 50;
const MAX_DESIGNS = 10;
const RUN_LIMITS = { timeoutMs: 180_000, memoryMb: 2048, cpuSeconds: 180, maxProcesses: 64, maxFileMb: 256, maxOutput: 20_000 };

function hostExecFile(file, args, options) {
  return new Promise((resolvePromise) => {
    execFile(file, args, options, (err, stdout, stderr) => resolvePromise({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  return match ? { text: match[0], major: Number(match[1]), minor: Number(match[2]) } : null;
}

// Whether kicad-cli is here and new enough. `kicad-cli version` takes no
// input, so this probe runs on the host; the checks themselves never do.
export function createToolProbe({ find = findExecutable, run = hostExecFile } = {}) {
  let cached = null;
  return async function probe() {
    if (cached) return cached;
    cached = (async () => {
      const path = find('kicad-cli');
      if (!path) return { available: false, reason: 'kicad-cli is not installed' };
      const { err, stdout, stderr } = await run(path, ['version'], { timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' } });
      const version = parseVersion(stdout) ?? parseVersion(stderr);
      if (err && !version) return { available: false, path, reason: `kicad-cli did not report a version: ${String(stderr || err.message).trim().slice(0, 200)}` };
      if (!version) return { available: false, path, reason: 'kicad-cli did not report a version' };
      if (version.major < MIN_MAJOR) {
        return { available: false, path, version: version.text, reason: `kicad-cli ${version.text} has no ERC/DRC commands (KiCad ${MIN_MAJOR} or later is needed)` };
      }
      return { available: true, path, version: version.text };
    })();
    return cached;
  };
}

// The violations of a kicad-cli JSON report (schemas.kicad.org erc.v1 and
// drc.v1), flattened, with counts by severity. Excluded and ignored entries
// are not counted.
export function summarizeReport(kind, report) {
  if (!report || typeof report !== 'object') throw new KicadError('bad_report', `the ${kind.toUpperCase()} report is not a JSON object`);
  const violations = [];
  const collect = (list, group, sheet = null) => {
    for (const entry of Array.isArray(list) ? list : []) {
      violations.push({
        group,
        sheet,
        severity: String(entry?.severity ?? 'error'),
        type: String(entry?.type ?? 'unknown'),
        description: String(entry?.description ?? ''),
        items: (Array.isArray(entry?.items) ? entry.items : []).map((item) => String(item?.description ?? '')).filter(Boolean),
        excluded: entry?.excluded === true,
      });
    }
  };
  if (kind === 'erc') {
    if (!Array.isArray(report.sheets)) throw new KicadError('bad_report', 'the ERC report has no sheets');
    for (const sheet of report.sheets) collect(sheet?.violations, 'violations', sheet?.path ?? null);
  } else {
    if (!Array.isArray(report.violations)) throw new KicadError('bad_report', 'the DRC report has no violations list');
    collect(report.violations, 'violations');
    collect(report.unconnected_items, 'unconnected_items');
    collect(report.schematic_parity, 'schematic_parity');
  }
  const counted = violations.filter((entry) => !entry.excluded && !['ignore', 'exclusion', 'excluded'].includes(entry.severity));
  const errors = counted.filter((entry) => entry.severity === 'error').length;
  const warnings = counted.filter((entry) => entry.severity === 'warning').length;
  return { errors, warnings, violations: counted.slice(0, MAX_LISTED_VIOLATIONS), total: counted.length, kicadVersion: report.kicad_version ?? null };
}

function describe(kind, file, summary) {
  const name = kind.toUpperCase();
  const head = `${name} ${file}: ${summary.errors} error${summary.errors === 1 ? '' : 's'}, ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`;
  const lines = summary.violations
    .filter((entry) => entry.severity === 'error')
    .slice(0, 10)
    .map((entry) => `- ${entry.type}: ${entry.description}${entry.items.length ? ` (${entry.items.join('; ')})` : ''}`);
  return [head, ...lines].join('\n');
}

// The files a check needs, by kind: a schematic with its sheets, or a board,
// each with the project file (it holds the ERC/DRC severities) and the
// board's design rules.
async function designFiles(root, kind, rel) {
  const base = rel.slice(0, rel.lastIndexOf('.'));
  const extras = [`${base}.kicad_pro`, ...(kind === 'drc' ? [`${base}.kicad_dru`] : [])];
  const main = kind === 'erc' ? (await loadSchematic(root, rel)).files : [rel];
  const present = [];
  for (const extra of extras) {
    try {
      const { abs } = resolveInside(root, extra);
      if ((await lstat(abs)).isFile()) present.push(extra);
    } catch {
      // Optional: KiCad uses its defaults without them.
    }
  }
  return [...main, ...present];
}

export function createChecker({ sandbox, probe = createToolProbe(), makeScratch = createScratchSandbox, removeScratch = removeSandbox } = {}) {
  async function checkOne(kind, root, rel, ctx, tool) {
    const files = await designFiles(root, kind, rel);
    const scratch = await makeScratch();
    try {
      const work = join(scratch.scratch, 'design');
      for (const file of files) {
        const { rel: safe, text } = await readDesignFile(root, file);
        await mkdir(dirname(join(work, safe)), { recursive: true });
        await writeFile(join(work, safe), text, { mode: 0o644 });
      }
      const report = join(scratch.scratch, `${kind}-report.json`);
      const args = kind === 'erc'
        ? ['sch', 'erc', '--format', 'json', '--units', 'mm', '--severity-all', '--output', report, join(work, rel)]
        : ['pcb', 'drc', '--format', 'json', '--units', 'mm', '--severity-all', '--output', report, join(work, rel)];
      const result = await sandbox.run({
        command: tool.path ?? 'kicad-cli',
        args,
        cwd: work,
        writable: [scratch.scratch],
        protect: ctx.localPath ? [ctx.localPath] : [],
        signal: ctx.signal,
        ...RUN_LIMITS,
      });
      let text = null;
      try {
        const stat = await lstat(report);
        if (stat.isFile() && stat.size <= MAX_REPORT_BYTES) text = await readFile(report, 'utf8');
      } catch {
        text = null;
      }
      if (text == null) {
        const status = result.timedOut ? 'timed out' : `exited ${result.exitCode}`;
        return { file: rel, ok: false, detail: `kicad-cli ${kind} ${status} without a report${result.output ? `\n${result.output.slice(-1000)}` : ''}` };
      }
      let summary;
      try {
        summary = summarizeReport(kind, JSON.parse(text));
      } catch (err) {
        return { file: rel, ok: false, detail: `kicad-cli ${kind} wrote an unreadable report: ${err.message}` };
      }
      return { file: rel, ok: summary.errors === 0, detail: describe(kind, rel, summary), ...summary };
    } finally {
      await removeScratch(scratch).catch(() => {});
    }
  }

  // Runs ERC or DRC on the design the step worked on (`result.output`'s
  // schematic or board, when it names one), else on every root design in
  // the project.
  async function check(kind, result, ctx) {
    const ext = kind === 'erc' ? '.kicad_sch' : '.kicad_pcb';
    let root;
    try {
      root = checkoutRoot(ctx);
    } catch {
      return { ok: true, unavailable: true, detail: 'the project has no folder to check' };
    }
    const named = kind === 'erc' ? result?.output?.schematic : result?.output?.board;
    let targets;
    if (typeof named === 'string' && named.endsWith(ext)) {
      targets = [await chooseDesign(root, { requested: named, ext })];
    } else {
      const { files } = await listKicadFiles(root);
      const candidates = files.filter((file) => file.endsWith(ext));
      targets = kind === 'erc' ? await rootSchematics(root, candidates) : candidates;
    }
    if (targets.length === 0) return { ok: true, unavailable: true, detail: `the project has no ${ext} file to check` };
    if (targets.length > MAX_DESIGNS) targets = targets.slice(0, MAX_DESIGNS);

    const tool = await probe();
    if (!tool.available) return { ok: true, unavailable: true, detail: `${kind.toUpperCase()} not run: ${tool.reason}` };
    let state;
    try {
      state = await sandbox.status();
    } catch (err) {
      state = { available: false, reason: err?.message ?? 'the sandbox probe failed' };
    }
    if (!state.available) {
      return { ok: false, unverified: true, detail: `${kind.toUpperCase()} not run: no OS sandbox is available (${state.reason}), and kicad-cli is never run unsandboxed` };
    }

    const checks = [];
    for (const target of targets) checks.push(await checkOne(kind, root, target, ctx, tool));
    return {
      ok: checks.every((entry) => entry.ok),
      detail: checks.map((entry) => entry.detail).join('\n\n'),
      tool: 'kicad-cli',
      version: tool.version ?? null,
      checks: checks.map(({ violations, ...entry }) => entry),
    };
  }

  return { check, probe };
}
