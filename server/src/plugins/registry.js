import { listPlugins, registerPlugin } from '../workspace/capabilities.js';

// The plug-ins whose capabilities agents can use. A vertical adds one import
// and one entry here; nothing else in the engine changes.
const BUILT_IN = [];

// Safe to call more than once (the engine and tests both call it): a plug-in
// that is already registered is skipped rather than refused.
export function registerBuiltInPlugins(plugins = BUILT_IN) {
  const registered = new Set(listPlugins());
  for (const plugin of plugins) {
    if (!registered.has(plugin.name)) registerPlugin(plugin);
  }
}
