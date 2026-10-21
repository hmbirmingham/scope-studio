// The step chooser: the one model call that picks what a step does. It sees
// the goal, the packed slice and the capabilities the role may use, never a
// transcript of earlier steps, so its prompt is the same size at step 40 as at
// step 2. Its reply is strict JSON, validated here before anything runs.

const SUMMARY_MAX = 500;
const CAPABILITY_LINE_MAX = 400;

export function sliceText(nodes) {
  if (nodes.length === 0) return '(nothing in the graph yet)';
  return nodes
    .map((node) => `[${node.type}${node.project ? ` · ${node.project}` : ''} · ${node.id}]\n${node.content}`)
    .join('\n\n');
}

function describeCapability(capability) {
  const schema = capability.input ?? {};
  const fields = Object.entries(schema.properties ?? {})
    .map(([name, spec]) => `${name}${(schema.required ?? []).includes(name) ? '' : '?'}: ${spec?.type ?? 'any'}`)
    .join(', ');
  const line = `- ${capability.name}(${fields})${capability.description ? ` — ${capability.description}` : ''}`;
  return line.length > CAPABILITY_LINE_MAX ? `${line.slice(0, CAPABILITY_LINE_MAX - 1)}…` : line;
}

function persona(agent) {
  const role = agent.role ?? {};
  return [role.embodiment, role.title ? `Your role: ${role.title}.` : null].filter(Boolean).join(' ');
}

export function planMessages({ agent, goal, slice, capabilities }) {
  return [
    {
      role: 'system',
      content: [
        persona(agent),
        'You plan work for an agent that acts one capability at a time and keeps its memory in a knowledge graph.',
        'Write a short numbered plan (at most 8 steps) for the goal. Each step should use one of the listed capabilities.',
        'Reply with the plan only.',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: `Goal:\n${goal}\n\nCapabilities:\n${capabilities.map(describeCapability).join('\n') || '(none)'}\n\nWhat the graph holds:\n${sliceText(slice)}`,
    },
  ];
}

export function chooserMessages({ agent, goal, slice, capabilities, stepIndex }) {
  return [
    {
      role: 'system',
      content: [
        persona(agent),
        'You choose the next single step of a run. The graph slice below holds the plan, what earlier steps found and the relevant project material.',
        'Reply with exactly one JSON object and nothing else:',
        '{"capability": "<name from the list>", "input": {…}, "hard": false, "done": false, "summary": "<one sentence: what this step does>"}',
        'Set "hard": true only when the step needs a stronger model. When the goal is met, reply {"done": true, "summary": "<what was achieved>"}.',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: `Goal:\n${goal}\n\nThis is step ${stepIndex}.\n\nCapabilities:\n${capabilities.map(describeCapability).join('\n') || '(none)'}\n\nGraph slice:\n${sliceText(slice)}`,
    },
  ];
}

// Small local models wrap JSON in prose, code fences or a think block; the
// first balanced object is taken and everything around it ignored. Anything
// that still is not one well-typed object is refused, never guessed at.
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

export function parseChoice(text) {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, error: 'chooser_not_json' };
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: 'chooser_not_json' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'chooser_not_object' };

  const { capability, input = {}, hard = false, done = false, summary } = value;
  if (typeof done !== 'boolean') return { ok: false, error: 'chooser_done_not_boolean' };
  if (typeof hard !== 'boolean') return { ok: false, error: 'chooser_hard_not_boolean' };
  if (summary != null && typeof summary !== 'string') return { ok: false, error: 'chooser_summary_not_string' };
  if (capability != null && (typeof capability !== 'string' || !capability)) return { ok: false, error: 'chooser_capability_not_string' };
  if (!done && capability == null) return { ok: false, error: 'chooser_no_capability' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'chooser_input_not_object' };

  return {
    ok: true,
    choice: {
      capability: capability ?? null,
      input,
      hard,
      done,
      summary: summary ? summary.slice(0, SUMMARY_MAX) : null,
    },
  };
}

function typeMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // A type this checker does not know is not enforced here; the
      // capability's own verifier is the backstop.
      return true;
  }
}

// Checks a capability input against its declared schema: required fields,
// the primitive type of each declared field, and no undeclared fields when
// the schema says so. Returns null when valid, else a reason.
export function validateInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const name of schema?.required ?? []) {
    if (input[name] === undefined) return `input.${name} is required`;
  }
  const properties = schema?.properties ?? {};
  for (const [name, value] of Object.entries(input)) {
    const spec = properties[name];
    if (!spec) {
      if (schema?.additionalProperties === false) return `input.${name} is not allowed`;
      continue;
    }
    const types = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
    if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
      return `input.${name} must be ${types.join(' or ')}`;
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) return `input.${name} must be one of ${spec.enum.join(', ')}`;
  }
  return null;
}
