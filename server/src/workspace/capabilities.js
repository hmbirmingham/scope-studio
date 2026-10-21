import { CAPABILITIES } from './permissions.js';

// The plug-in capability registry (docs/architecture/agent-workspace.md,
// "Plug-in capability contract"). A plug-in declares what it can do; roles
// select capabilities by tag; the runner looks capabilities up by name. A bad
// declaration is refused at registration, not discovered mid-run.

const NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/;

const plugins = new Map();
const capabilities = new Map();
const verifiers = new Map();

function fail(plugin, message) {
  throw new Error(`plug-in ${plugin}: ${message}`);
}

function checkTags(plugin, entry) {
  if (!Array.isArray(entry.tags) || entry.tags.length === 0 || !entry.tags.every((tag) => typeof tag === 'string' && tag)) {
    fail(plugin, `${entry.name} needs at least one tag`);
  }
}

function checkCapability(plugin, capability) {
  if (typeof capability?.name !== 'string' || !NAME.test(capability.name)) {
    fail(plugin, `capability name "${capability?.name}" must look like "${plugin}.action"`);
  }
  checkTags(plugin, capability);
  if (!CAPABILITIES.includes(capability.permission)) {
    fail(plugin, `${capability.name} declares unknown permission "${capability.permission}"`);
  }
  if (!capability.input || capability.input.type !== 'object') {
    fail(plugin, `${capability.name} needs an object input schema`);
  }
  if (typeof capability.run !== 'function') fail(plugin, `${capability.name} has no run()`);
  if (capability.verifiers != null && !Array.isArray(capability.verifiers)) {
    fail(plugin, `${capability.name} verifiers must be a list of names`);
  }
}

function checkVerifier(plugin, verifier) {
  if (typeof verifier?.name !== 'string' || !NAME.test(verifier.name)) {
    fail(plugin, `verifier name "${verifier?.name}" must look like "${plugin}.check"`);
  }
  checkTags(plugin, verifier);
  if (typeof verifier.verify !== 'function') fail(plugin, `${verifier.name} has no verify()`);
}

export function registerPlugin(plugin) {
  const name = plugin?.name;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('a plug-in needs a lower-case name');
  if (plugins.has(name)) throw new Error(`plug-in ${name} is already registered`);

  const declared = plugin.capabilities ?? [];
  const checks = plugin.verifiers ?? [];
  declared.forEach((capability) => checkCapability(name, capability));
  checks.forEach((verifier) => checkVerifier(name, verifier));

  // Names are checked against everything already registered and within the
  // declaration itself before anything is added, so a refused plug-in leaves
  // the registry exactly as it was.
  const seen = new Set();
  for (const entry of [...declared, ...checks]) {
    if (capabilities.has(entry.name) || verifiers.has(entry.name) || seen.has(entry.name)) {
      fail(name, `${entry.name} is already registered`);
    }
    seen.add(entry.name);
  }

  // A capability may name a verifier from another plug-in, but it must exist
  // by the time this plug-in registers.
  for (const capability of declared) {
    for (const verifier of capability.verifiers ?? []) {
      if (!verifiers.has(verifier) && !checks.some((check) => check.name === verifier)) {
        fail(name, `${capability.name} names unknown verifier "${verifier}"`);
      }
    }
  }

  for (const capability of declared) capabilities.set(capability.name, { ...capability, plugin: name, verifiers: capability.verifiers ?? [] });
  for (const verifier of checks) verifiers.set(verifier.name, { ...verifier, plugin: name });
  plugins.set(name, plugin);
}

export function getCapability(name) {
  return capabilities.get(name) ?? null;
}

export function getVerifier(name) {
  return verifiers.get(name) ?? null;
}

// The capabilities a role may use: those carrying at least one of its tags.
export function capabilitiesForTags(tags = []) {
  const wanted = new Set(tags);
  return [...capabilities.values()].filter((capability) => capability.tags.some((tag) => wanted.has(tag)));
}

export function listPlugins() {
  return [...plugins.keys()];
}

export function resetRegistry() {
  plugins.clear();
  capabilities.clear();
  verifiers.clear();
}
