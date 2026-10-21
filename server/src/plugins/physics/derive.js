import { extractJsonObject } from '../../workspace/runner/chooser.js';
import { PhysicsError } from './python.js';
import { validateDerivation } from './spec.js';

// The model's half of physics.derive: one request for a derivation as strict
// JSON with explicit assumptions, units and limiting cases, and one repair
// request if the reply does not validate. Small local models often get the
// shape wrong once and right when told exactly what was wrong.

const MAX_TOKENS = 1_500;
const ATTEMPTS = 2;
const MAX_PROBLEM_CHARS = 6_000;

const FORMAT = `{
  "title": "<short name of the result>",
  "result": { "symbol": "T", "expression": "2*pi*sqrt(L/g)", "units": "s" },
  "variables": { "L": { "value": "1 m", "description": "pendulum length" }, "g": { "value": "9.81 m/s^2", "description": "gravitational acceleration" } },
  "assumptions": ["<every assumption the result depends on>"],
  "steps": ["<the derivation, one step per entry>"],
  "limits": [ { "name": "<limiting case>", "set": { "<variable>": "<value near the limit, with units>" }, "expect": "<expression the result must approach there>", "rtol": 0.001 } ]
}`;

const RULES = [
  'Derive the requested result. Reply with exactly one JSON object in this format and nothing else:',
  FORMAT,
  'Rules:',
  '- expression uses only the declared variables, numbers, pi, e, + - * / ** and sqrt, abs, sin, cos, tan, asin, acos, atan, atan2, hypot, sinh, cosh, tanh, exp, log, log10, erf, ellipk, ellipe (m = k^2).',
  '- Every variable has a representative value with explicit units (Pint syntax, e.g. "9.81 m/s^2", "0.2 rad", "100 uF"); result.units are the units the result is expressed in.',
  '- State every assumption explicitly (small angles, no drag, ideal components…).',
  '- Give at least one limiting case: set variables close to the limit and give the expression (or expectValue, a quantity) the result must approach; rtol is the relative tolerance (at most 0.05), atol an optional absolute tolerance in result units.',
];

export function derivationMessages({ agent, problem, context }) {
  const persona = agent?.role?.embodiment ? `${agent.role.embodiment}\n\n` : '';
  return [
    { role: 'system', content: `${persona}${RULES.join('\n')}` },
    { role: 'user', content: `Problem:\n${problem}${context ? `\n\nFrom the project:\n${context.slice(0, MAX_PROBLEM_CHARS)}` : ''}` },
  ];
}

async function complete(model, messages, signal) {
  let text = '';
  for await (const chunk of model.stream({ messages, maxTokens: MAX_TOKENS, signal })) {
    if (chunk?.text) text += chunk.text;
  }
  return text;
}

export function parseDerivationReply(text) {
  const json = extractJsonObject(text);
  if (!json) throw new PhysicsError('invalid_derivation', 'the reply held no JSON object');
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new PhysicsError('invalid_derivation', 'the reply was not valid JSON');
  }
  try {
    return validateDerivation(raw);
  } catch (err) {
    throw new PhysicsError('invalid_derivation', err.message);
  }
}

export async function requestDerivation({ model, agent, problem, context, signal }) {
  if (!model || typeof model.stream !== 'function') throw new PhysicsError('no_model', 'physics.derive needs a model (ctx.model)');
  const messages = derivationMessages({ agent, problem, context });
  let lastError = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const reply = await complete(model, messages, signal);
    try {
      return { derivation: parseDerivationReply(reply), attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      messages.push({ role: 'assistant', content: reply.slice(0, 4_000) });
      messages.push({ role: 'user', content: `That reply cannot be used: ${err.message}. Reply again with one JSON object in the required format.` });
    }
  }
  throw lastError;
}
