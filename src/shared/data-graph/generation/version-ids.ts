/**
 * Version ID Constants
 *
 * Extracted to a separate file to avoid circular dependency:
 * common.ts → config/workflows.ts → kling-graph.ts → common.ts
 *
 * These constants are imported by both graph files and config/workflows.ts.
 */

/** Kling model version IDs */
export const klingVersionIds = {
  v1_6: 2623815,
  v2: 2623817,
  v2_5_turbo: 2623821,
  v3: 2698632,
} as const;

/** Nano Banana mode version IDs */
export const nanoBananaVersionIds = {
  standard: 2154472,
  pro: 2436219,
  v2: 2725610,
} as const;
