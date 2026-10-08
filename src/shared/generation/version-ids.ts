import type { BaseModelGroup } from '~/shared/constants/basemodel.constants';

/**
 * Leaf module: model version-id constants for ecosystems whose workflow registry
 * (config/workflows.ts) needs to reference them.
 *
 * These live here — not in the per-ecosystem *.graph.ts files — to keep the
 * dependency one-directional. `config/workflows.ts` and the graph files both
 * import from this module, which imports no VALUES, so it can never participate in
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
  v2lite: 3086021,
  v21: 3390330,
} as const;

export const minimaxVersionIds = {
  /** MiniMax's hosted API. */
  'v1.0': 3183239,
  /** Our own weights. The `MiniMaxH3` ecosystem default, and the only one taking LoRAs. */
  comfy: 3216500,
  /** H3 Max and Max Turbo, through FAL. */
  max: 3388469,
  /** HeyGen Video 1 (built on H3). First frame only, no last frame. */
  heygen: 3388470,
} as const;

export const qwenVersionIds = {
  imageEdit2511: 2558804,
} as const;

export const viduVersionIds = {
  q1: 2623839,
  q3: 2741273,
  q4: 3392572,
} as const;

export const happyHorseVersionIds = {
  'v1.0': 2902378,
  'v1.1': 3063263,
} as const;

export const flux3VideoVersionIds = {
  'v3.0': 3204701,
} as const;

export const grokVersionIds = {
  'v1.0': 2738377,
  'v1.5': 3197990,
  'v2.0': 3225510,
} as const;

/**
 * The implied Wan checkpoint for a base-model group, used by `getMetaResources` to add it
 * back when resolving image metadata — a Wan generation records the group, not the version.
 */
export const wanBaseModelGroupIdMap: Partial<Record<BaseModelGroup, number>> = {
  WanVideo1_3B_T2V: 1500646,
  WanVideo14B_T2V: 1707796,
  WanVideo14B_I2V_480p: 1501125,
  WanVideo14B_I2V_720p: 1501344,
};
