import { canAutoCloud, canChooseCloud, PLANS } from '../billing/plans.js';

// The plug-ins the engine ships today. A new discipline (kicad, zotero,
// overleaf, a CVE feed, ...) is added here once the engine carries it.
export const SHIPPED_PLUGINS = ['github', 'local_folder'];

// Which plug-ins each plan may use. Every plan gets every shipped plug-in
// today; the table exists so gating one by plan later is a one-line change
// here, picked up by the engine from /v1/me without a release.
export const PLAN_PLUGINS = {
  free: SHIPPED_PLUGINS,
  key_pro: SHIPPED_PLUGINS,
  student: SHIPPED_PLUGINS,
  engineer: SHIPPED_PLUGINS,
};

export function pluginsFor(plan) {
  return [...(PLAN_PLUGINS[plan] ?? PLAN_PLUGINS.free)];
}

export function capabilitiesFor(plan) {
  return {
    chooseCloud: canChooseCloud(plan),
    autoCloud: canAutoCloud(plan),
    plugins: pluginsFor(plan),
  };
}

// Every plan must say what it may use, or a new plan would silently get the
// Free list; checked by a unit test rather than at request time.
export function plansWithoutPlugins() {
  return Object.keys(PLANS).filter((plan) => !PLAN_PLUGINS[plan]);
}
