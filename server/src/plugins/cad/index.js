import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resolveInside } from '../code/paths.js';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, defaultCadQuery } from './cadquery.js';
import { CadError } from './errors.js';
import { meshInterference } from './interference.js';
import { describeChecks, evaluateChecks, validateChecks } from './measure.js';
import { analyseMesh, geometryProblems, integrals, midPlane, section } from './mesh.js';
import { OUTPUT_DIR, formatOf, projectConfig, readCadFile } from './project.js';
import { readStep } from './step.js';
import { encodeBinaryStl, parseStl } from './stl.js';
import { convertLength, densityToSi, metresPer, round } from './units.js';

// The CAD vertical (docs/architecture/agent-workspace.md, "Verticals").
// Open formats first: STL is read and measured in JavaScript, STEP's product
// structure too; anything that needs a B-rep kernel (STEP geometry, solid
// interference, parametric edits) goes to CadQuery, which only ever runs in
// the OS sandbox (cadquery.js). When CadQuery is missing a capability that
// needs it refuses with `tool_unavailable`, and a verifier that needs it
// reports itself unavailable rather than passing a check it did not make.

const MAX_SCRIPT_CHARS = 200 * 1024;
const MAX_INTERFERENCE_FILES = 12;

function requirePath(input, key = 'path') {
  const value = input?.[key];
  if (typeof value !== 'string' || !value || value.length > 1024) throw new CadError('invalid_input', `${key} must be a project-relative file path`);
  return value;
}

function optionalSection(input) {
  if (input?.section == null) return null;
  const { axis = 'z', at } = input.section;
  if (!['x', 'y', 'z'].includes(axis)) throw new CadError('invalid_input', 'section axis must be x, y or z');
  if (at != null && (typeof at !== 'number' || !Number.isFinite(at))) throw new CadError('invalid_input', 'section at must be a number');
  return { axis, at };
}

const fmt = (value, digits = 6) => (value == null ? '?' : String(Number(Number(value).toPrecision(digits))));

function scaleTriangles(triangles, factor) {
  if (factor === 1) return triangles;
  const scaled = new Float64Array(triangles.length);
  for (let i = 0; i < triangles.length; i += 1) scaled[i] = triangles[i] * factor;
  return scaled;
}

function publicAnalysis(analysis) {
  const { inertia: _inertia, ...rest } = analysis;
  return rest;
}

function meshSummary(rel, analysis, units) {
  const size = analysis.boundingBox.size.map((v) => fmt(v)).join(' × ');
  const state = analysis.watertight ? 'watertight' : `not watertight (${analysis.boundaryEdges} open edges)`;
  return `${rel}: ${size} ${units}, volume ${fmt(analysis.volume)} ${units}³, area ${fmt(analysis.surfaceArea)} ${units}², ${analysis.triangles} triangles, ${state}`;
}

export function createCadPlugin({ cadquery = defaultCadQuery } = {}) {
  // A file as a mesh in the project's unit: STL directly, STEP through a
  // CadQuery tessellation (OCCT works in millimetres).
  async function loadMesh(ctx, path, { signal } = {}) {
    const config = await projectConfig(ctx);
    const file = await readCadFile(ctx, path);
    if (file.format === 'stl') {
      const mesh = parseStl(file.buffer);
      return { file, config, units: config.units, triangles: mesh.triangles, stl: mesh };
    }
    const [info] = await cadquery.inspect([{ name: file.rel, buffer: file.buffer }], { mesh: true, signal });
    if (!info.meshBuffer) throw new CadError('cadquery_failed', `CadQuery did not tessellate ${file.rel}`);
    const triangles = scaleTriangles(parseStl(info.meshBuffer).triangles, convertLength(1, 'mm', config.units));
    return { file, config, units: config.units, triangles, brep: info };
  }

  async function inspect(input, ctx) {
    const path = requirePath(input);
    const sectionSpec = optionalSection(input);
    const config = await projectConfig(ctx);
    const file = await readCadFile(ctx, path);

    if (file.format === 'stl') {
      const mesh = parseStl(file.buffer);
      const analysis = analyseMesh(mesh.triangles);
      const output = {
        path: file.rel,
        format: 'stl',
        encoding: mesh.format,
        name: mesh.name,
        units: config.units,
        ...publicAnalysis(analysis),
        problems: geometryProblems(analysis),
      };
      if (sectionSpec) output.section = section(mesh.triangles, { axis: sectionSpec.axis, at: sectionSpec.at ?? midPlane(mesh.triangles, sectionSpec.axis) });
      return { output, findings: [meshSummary(file.rel, analysis, config.units)] };
    }

    const structure = readStep(file.buffer);
    const output = {
      path: file.rel,
      format: 'step',
      header: structure.header,
      lengthUnit: structure.lengthUnit,
      products: structure.products,
      counts: structure.counts,
      geometry: null,
    };
    // A file of product structure only (no solids) has no geometry to
    // measure, and needs no CadQuery to say so.
    const status = structure.counts.solids > 0 ? await cadquery.status() : null;
    if (!status) {
      output.geometry = { solids: 0 };
    } else if (!status.available) {
      output.geometry = { unavailable: true, reason: status.reason };
    } else {
      const [info] = await cadquery.inspect([{ name: file.rel, buffer: file.buffer }], { mesh: Boolean(sectionSpec), signal: ctx.signal });
      const { meshBuffer, name: _name, ...geometry } = info;
      output.geometry = geometry;
      if (sectionSpec && meshBuffer) {
        const triangles = scaleTriangles(parseStl(meshBuffer).triangles, convertLength(1, 'mm', config.units));
        output.section = section(triangles, { axis: sectionSpec.axis, at: sectionSpec.at ?? midPlane(triangles, sectionSpec.axis) });
      }
    }
    const assemblies = structure.products.filter((p) => p.kind === 'assembly').length;
    const parts = structure.products.length - assemblies;
    const geometryText = output.geometry.unavailable
      ? 'geometry not measured (CadQuery unavailable)'
      : output.geometry.solids === 0
        ? 'no solid geometry in the file'
        : `${output.geometry.solids} solid(s), volume ${fmt(output.geometry.volume)} mm³, ${output.geometry.valid ? 'valid' : 'INVALID'} B-rep`;
    return { output, findings: [`${file.rel}: STEP with ${assemblies} assembly(ies) and ${parts} part(s); ${geometryText}`] };
  }

  async function massProperties(input, ctx) {
    const path = requirePath(input);
    const config = await projectConfig(ctx);
    const density = input?.density ?? config.density;
    if (density == null) throw new CadError('invalid_input', 'density is required: pass { value, unit } or declare one in cad.json');
    const { kgPerM3, unit: densityUnit } = densityToSi(density);
    const file = await readCadFile(ctx, path);

    let units;
    let volume;
    let centroid;
    let inertiaUnitDensity; // in units^5
    let area;
    let method;
    if (file.format === 'stl') {
      const mesh = parseStl(file.buffer);
      const analysis = analyseMesh(mesh.triangles);
      if (!analysis.watertight) throw new CadError('not_watertight', `${file.rel} is not watertight, so it encloses no definite volume`);
      const props = integrals(mesh.triangles);
      // An inside-out mesh has every integral negated; its solid is the same.
      const sign = Math.sign(props.volume) || 1;
      units = config.units;
      volume = Math.abs(props.volume);
      centroid = props.centroid;
      inertiaUnitDensity = props.inertia?.map((row) => row.map((v) => v * sign));
      area = analysis.surfaceArea;
      method = 'mesh';
    } else {
      const [info] = await cadquery.inspect([{ name: file.rel, buffer: file.buffer }], { signal: ctx.signal });
      if (!(info.volume > 0)) throw new CadError('invalid_geometry', `${file.rel} has no solid volume`);
      units = 'mm';
      volume = info.volume;
      centroid = info.centroid;
      inertiaUnitDensity = info.inertia;
      area = info.surfaceArea;
      method = 'brep';
    }
    const s = metresPer(units);
    const volumeM3 = volume * s ** 3;
    const mass = kgPerM3 * volumeM3;
    const inertia = inertiaUnitDensity ? inertiaUnitDensity.map((row) => row.map((v) => round(v * kgPerM3 * s ** 5))) : null;
    const output = {
      path: file.rel,
      format: file.format,
      method,
      units,
      density: { value: density.value, unit: densityUnit, kgPerM3: round(kgPerM3) },
      volume: { value: round(volume), unit: `${units}^3` },
      volumeM3: round(volumeM3),
      surfaceArea: { value: round(area), unit: `${units}^2` },
      mass: { value: round(mass), unit: 'kg' },
      centreOfMass: { value: centroid ? centroid.map((v) => round(v)) : null, unit: units },
      // About the centre of mass, axes parallel to the model's.
      inertia: { value: inertia, unit: 'kg*m^2' },
    };
    return { output, findings: [`${file.rel}: mass ${fmt(mass)} kg at ${fmt(density.value)} ${densityUnit}; volume ${fmt(volume)} ${units}³; centre of mass (${output.centreOfMass.value?.map((v) => fmt(v)).join(', ')}) ${units}`] };
  }

  // Pairwise interference between files. STL against STL is checked on the
  // meshes in JavaScript; STEP against STEP with CadQuery booleans on the
  // solids (a single STEP file: its solids against each other); a mix
  // tessellates the STEP files and compares meshes.
  async function interferenceOf(ctx, paths, { tolerance, signal } = {}) {
    const files = [];
    for (const path of paths) files.push(await readCadFile(ctx, path));
    const config = await projectConfig(ctx);
    const steps = files.filter((f) => f.format === 'step');

    if (steps.length === files.length) {
      const reply = await cadquery.interference(files.map((f) => ({ name: f.rel, buffer: f.buffer })), {
        withinFiles: files.length === 1,
        // A length in the project's unit becomes the overlap volume (mm³)
        // below which two solids only touch.
        tolerance: tolerance != null ? convertLength(tolerance, config.units, 'mm') ** 3 : undefined,
        signal,
      });
      return {
        method: 'brep',
        units: 'mm',
        pairs: reply.pairs.map((p) => ({ a: p.a, b: p.b, interferes: p.interferes, overlapVolume: round(p.volume) })),
      };
    }
    if (files.length < 2) throw new CadError('invalid_input', 'an STL interference check needs at least two files');

    const meshes = [];
    for (const file of files) {
      if (file.format === 'stl') {
        const triangles = parseStl(file.buffer).triangles;
        meshes.push({ name: file.rel, triangles, watertight: analyseMesh(triangles).watertight });
      } else {
        const [info] = await cadquery.inspect([{ name: file.rel, buffer: file.buffer }], { mesh: true, signal });
        const triangles = scaleTriangles(parseStl(info.meshBuffer).triangles, convertLength(1, 'mm', config.units));
        meshes.push({ name: file.rel, triangles, watertight: analyseMesh(triangles).watertight });
      }
    }
    const pairs = [];
    for (let i = 0; i < meshes.length; i += 1) {
      for (let j = i + 1; j < meshes.length; j += 1) {
        const r = meshInterference(meshes[i], meshes[j], { tolerance });
        pairs.push({ a: meshes[i].name, b: meshes[j].name, interferes: r.interferes, reason: r.reason, crossingTrianglePairs: r.crossingPairs });
      }
    }
    return { method: steps.length ? 'mesh (STEP tessellated by CadQuery)' : 'mesh', units: config.units, pairs };
  }

  function interferencePaths(input) {
    let paths = input?.paths;
    if (paths == null && input?.path != null) paths = [input.path];
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_INTERFERENCE_FILES || !paths.every((p) => typeof p === 'string' && p)) {
      throw new CadError('invalid_input', `paths must list 1 to ${MAX_INTERFERENCE_FILES} project-relative files`);
    }
    return [...new Set(paths)];
  }

  async function interference(input, ctx) {
    const paths = interferencePaths(input);
    if (input?.tolerance != null && (typeof input.tolerance !== 'number' || !(input.tolerance >= 0))) throw new CadError('invalid_input', 'tolerance must be a non-negative number');
    const result = await interferenceOf(ctx, paths, { tolerance: input?.tolerance, signal: ctx.signal });
    const clashes = result.pairs.filter((p) => p.interferes);
    const output = { paths, ...result, interfering: clashes.length > 0 };
    const finding = clashes.length
      ? `Interference: ${clashes.map((p) => `${p.a} with ${p.b}`).join('; ')} (${result.method})`
      : `No interference between ${paths.join(', ')} (${result.pairs.length} pair(s), ${result.method})`;
    return { output, findings: [finding] };
  }

  // Where a parametric edit writes: the run's own copy (the sandbox
  // worktree), or for a run with no checkout copy its scratch directory.
  // Never the user's checkout.
  async function outputRoot(ctx) {
    if (!ctx.sandbox?.scratch && !ctx.sandbox?.worktree) throw new CadError('sandbox_required', 'parametric edits only write into a run sandbox');
    const root = ctx.sandbox.worktree ?? join(ctx.sandbox.scratch, OUTPUT_DIR);
    await mkdir(root, { recursive: true });
    return realpath(root);
  }

  async function writeOutput(root, rel, buffer) {
    const { abs: first } = resolveInside(root, rel);
    await mkdir(dirname(first), { recursive: true });
    // The parent may have been swapped for a link meanwhile; resolve again,
    // and open without following a link at the file itself.
    const { abs, rel: clean } = resolveInside(root, rel);
    const handle = await open(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(buffer);
    } finally {
      await handle.close();
    }
    return clean;
  }

  async function parametricEdit(input, ctx) {
    const script = input?.script;
    if (typeof script !== 'string' || !script.trim() || script.length > MAX_SCRIPT_CHARS) {
      throw new CadError('invalid_input', `script must be CadQuery Python of at most ${MAX_SCRIPT_CHARS} characters that assigns result`);
    }
    const output = requirePath(input, 'output');
    const format = formatOf(output);
    if (!format) throw new CadError('unsupported_format', 'output must end in .step, .stp or .stl');
    const expect = validateChecks(input.expect);
    const checkAgainst = input.checkAgainst == null ? [] : interferencePaths({ paths: input.checkAgainst });
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new CadError('invalid_input', `timeoutMs must be an integer from 1000 to ${MAX_TIMEOUT_MS}`);
    if (!ctx.sandbox) throw new CadError('sandbox_required', 'parametric edits only run in a run sandbox');
    const root = await outputRoot(ctx);
    // The output path is checked before anything runs, so a bad one costs
    // no CadQuery run.
    resolveInside(root, output);
    const config = await projectConfig(ctx);

    const inputs = [];
    for (const path of Array.isArray(input.inputs) ? input.inputs : []) {
      const file = await readCadFile(ctx, path);
      inputs.push({ name: path, buffer: file.buffer });
    }

    const edited = await cadquery.edit({ script, output: `result.${format === 'stl' ? 'stl' : 'step'}`, inputs, signal: ctx.signal, timeoutMs });
    let buffer = edited.file;
    // CadQuery's STL is in millimetres; an STL means whatever the project
    // says, so it is rescaled to the project's unit before it is written.
    if (format === 'stl' && config.units !== 'mm') {
      buffer = encodeBinaryStl(scaleTriangles(parseStl(buffer).triangles, convertLength(1, 'mm', config.units)));
    }
    const rel = await writeOutput(root, output, buffer);
    const triangles = edited.mesh ? scaleTriangles(parseStl(edited.mesh).triangles, convertLength(1, 'mm', config.units)) : null;
    const analysis = triangles ? analyseMesh(triangles) : null;
    const info = edited.info;
    const result = {
      path: rel,
      format,
      units: config.units,
      bytes: buffer.length,
      reported: {
        valid: info.valid,
        solids: info.solids,
        volume: info.volume != null ? round(info.volume * convertLength(1, 'mm', config.units) ** 3) : null,
        boundingBox: info.boundingBox ? { size: info.boundingBox.size.map((v) => round(v * convertLength(1, 'mm', config.units))) } : null,
      },
      mesh: analysis ? { boundingBox: analysis.boundingBox, volume: analysis.volume, watertight: analysis.watertight, triangles: analysis.triangles } : null,
      expect,
      checkAgainst,
    };
    const summary = analysis ? meshSummary(rel, analysis, config.units) : `${rel}: ${info.solids} solid(s)`;
    return {
      output: result,
      artifacts: [{ name: `CAD part ${basename(rel)}`, content: `${summary}\nWritten by a parametric edit to ${rel} in the run's sandbox copy.` }],
    };
  }

  // ---- verifiers: each measures the file again, never trusting the
  // capability's own report, and in a fresh CadQuery run when it needs one.

  function producedPath(result) {
    const path = result?.output?.path;
    return typeof path === 'string' && formatOf(path) ? path : null;
  }

  function unavailable(detail) {
    return { ok: true, unavailable: true, detail: `unavailable: ${detail}` };
  }

  async function cadQueryReady() {
    const state = await cadquery.status();
    return state.available ? null : state.reason;
  }

  const validGeometry = {
    name: 'cad.valid_geometry',
    tags: ['cad'],
    async verify(result, ctx) {
      const path = producedPath(result);
      if (!path) return unavailable('the step produced no part to check');
      const file = await readCadFile(ctx, path);
      if (file.format === 'stl') {
        const analysis = analyseMesh(parseStl(file.buffer).triangles);
        const problems = geometryProblems(analysis);
        return problems.length
          ? { ok: false, detail: `${file.rel}: ${problems.join('; ')}` }
          : { ok: true, detail: `${file.rel}: watertight, consistently oriented, no degenerate triangles, volume ${fmt(analysis.volume)}` };
      }
      const missing = await cadQueryReady();
      if (missing) return unavailable(`checking a STEP solid needs CadQuery (${missing})`);
      const [info] = await cadquery.inspect([{ name: file.rel, buffer: file.buffer }], { signal: ctx.signal });
      const problems = [];
      if (!info.valid) problems.push('the B-rep does not pass OCCT validity checks');
      if (!(info.solids > 0)) problems.push('it holds no solid');
      if (!(info.volume > 0)) problems.push('its volume is not positive');
      return problems.length
        ? { ok: false, detail: `${file.rel}: ${problems.join('; ')}` }
        : { ok: true, detail: `${file.rel}: ${info.solids} valid solid(s), volume ${fmt(info.volume)} mm³` };
    },
  };

  const dimensions = {
    name: 'cad.dimensions',
    tags: ['cad'],
    async verify(result, ctx) {
      const path = producedPath(result);
      if (!path) return unavailable('the step produced no part to measure');
      const config = await projectConfig(ctx);
      const declared = validateChecks(
        config.dimensions.filter((check) => check?.file === path || check?.file === result.output.path),
        'cad.json dimensions'
      );
      const checks = [...validateChecks(result.output.expect ?? []), ...declared];
      if (checks.length === 0) return unavailable(`no dimensions are declared for ${path}`);
      if (formatOf(path) === 'step') {
        const missing = await cadQueryReady();
        if (missing) return unavailable(`measuring a STEP part needs CadQuery (${missing})`);
      }
      const { triangles, units } = await loadMesh(ctx, path, { signal: ctx.signal });
      const results = evaluateChecks(triangles, checks, { units });
      return { ok: results.every((r) => r.ok), detail: `${path}\n${describeChecks(results)}` };
    },
  };

  const noInterference = {
    name: 'cad.no_interference',
    tags: ['cad'],
    async verify(result, ctx) {
      const path = producedPath(result);
      if (!path) return unavailable('the step produced no part to check');
      const config = await projectConfig(ctx);
      const others = new Set(Array.isArray(result.output.checkAgainst) ? result.output.checkAgainst : []);
      if (config.assembly.includes(path)) for (const member of config.assembly) others.add(member);
      others.delete(path);
      if (others.size === 0) return unavailable(`nothing is declared to fit with ${path}`);
      const paths = [path, ...others];
      if (paths.some((p) => formatOf(p) === 'step')) {
        const missing = await cadQueryReady();
        if (missing) return unavailable(`checking STEP parts for interference needs CadQuery (${missing})`);
      }
      const { pairs, method } = await interferenceOf(ctx, paths, { signal: ctx.signal });
      // Only pairs involving the produced part: the others' fit is not what
      // this step changed.
      const relevant = pairs.filter((p) => p.a.split('#')[0] === path || p.b.split('#')[0] === path);
      const clashes = relevant.filter((p) => p.interferes);
      return clashes.length
        ? { ok: false, detail: `${path} interferes with ${clashes.map((p) => (p.a.split('#')[0] === path ? p.b : p.a)).join(', ')} (${method})` }
        : { ok: true, detail: `${path} clears ${[...others].join(', ')} (${method})` };
    },
  };

  const readInput = (properties, required) => ({ type: 'object', required, properties });
  const densitySchema = {
    type: 'object',
    required: ['value', 'unit'],
    properties: { value: { type: 'number' }, unit: { type: 'string', description: 'kg/m3, g/cm3, g/mm3, kg/mm3, lb/in3 or lb/ft3' } },
  };
  const checkSchema = {
    type: 'array',
    description: 'Dimension checks: { measure, value, tolerance } or { measure, min, max }; measures size.x|y|z, volume, surfaceArea, holes.count, holes.spacing, holes.maxSpacing, holes.diameter, holes.maxDiameter, holes.minWall.',
    items: { type: 'object' },
  };

  return {
    name: 'cad',
    capabilities: [
      {
        name: 'cad.inspect',
        tags: ['cad'],
        permission: 'read_graph',
        source: 'cad',
        input: readInput(
          {
            path: { type: 'string', description: 'An .stl, .step or .stp file, relative to the project.' },
            section: { type: 'object', description: 'Optional cross-section { axis: x|y|z, at?: number } listing loops and holes.' },
          },
          ['path']
        ),
        verifiers: [],
        run: inspect,
      },
      {
        name: 'cad.mass_properties',
        tags: ['cad'],
        permission: 'read_graph',
        source: 'cad',
        input: readInput({ path: { type: 'string' }, density: densitySchema }, ['path']),
        verifiers: [],
        run: massProperties,
      },
      {
        name: 'cad.interference',
        tags: ['cad'],
        permission: 'read_graph',
        source: 'cad',
        input: readInput(
          {
            paths: { type: 'array', items: { type: 'string' }, description: 'Two or more parts, or one STEP assembly.' },
            tolerance: { type: 'number', description: 'Overlap ignored below this, in the project unit.' },
          },
          ['paths']
        ),
        verifiers: [],
        run: interference,
      },
      {
        name: 'cad.parametric_edit',
        tags: ['cad'],
        permission: 'run_generated_code',
        input: readInput(
          {
            script: { type: 'string', description: 'CadQuery Python (cq is imported) that assigns the part to `result`; project_path(name) gives a declared input file.' },
            output: { type: 'string', description: 'Where to write the part in the project, ending .step, .stp or .stl.' },
            inputs: { type: 'array', items: { type: 'string' }, description: 'Project files the script may read with project_path().' },
            expect: checkSchema,
            checkAgainst: { type: 'array', items: { type: 'string' }, description: 'Parts the result must not interfere with.' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS },
          },
          ['script', 'output']
        ),
        verifiers: ['cad.valid_geometry', 'cad.dimensions', 'cad.no_interference'],
        run: parametricEdit,
      },
    ],
    verifiers: [validGeometry, dimensions, noInterference],
  };
}

export default createCadPlugin();
