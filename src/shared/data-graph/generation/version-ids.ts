/**
 * Leaf module: model version-id constants for ecosystems whose workflow registry
 * (config/workflows.ts) needs to reference them.
 *
 * These live here — not in the per-ecosystem *-graph.ts files — to keep the
 * dependency one-directional. `config/workflows.ts` and the graph files both
 * import from this module, which imports nothing, so it can never participate in
 * the `graph -> common -> config -> graph` import cycle that otherwise leaves
 * these constants `undefined` at module-eval time depending on load order.
 */
export const klingVersionIds = {
  v1_6: 2623815,
  v2: 2623817,
  v2_5_turbo: 2623821,
  v3: 2698632,
} as const;

export const nanoBananaVersionIds = {
  standard: 2154472,
  pro: 2436219,
  v2: 2725610,
} as const;

export const viduVersionIds = {
  q1: 2623839,
  q3: 2741273,
} as const;

export const happyHorseVersionIds = {
  'v1.0': 2902378,
  'v1.1': 3063263,
} as const;
