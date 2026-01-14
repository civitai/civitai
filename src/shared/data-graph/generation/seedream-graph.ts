/**
 * Seedream Family Graph V2
 *
 * Controls for Seedream ecosystem (ByteDance).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Seedream versions: v3, v4, v4.5
 *
 * Note: No LoRA support, no negative prompts, samplers, steps, or CLIP skip.
 * Uses CFG scale (guidance), seed, and aspect ratio.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  cfgScaleNode,
  createCheckpointGraph,
  seedNode,
} from './common';

// =============================================================================
// Seedream Version Constants
// =============================================================================

/** Seedream version type */
export type SeedreamVersion = 'v3' | 'v4' | 'v4.5';

/** Seedream version IDs */
const seedreamVersionIds = {
  v3: 2208174,
  v4: 2208278,
  'v4.5': 2470991,
} as const;

/** Options for seedream version selector (using version IDs as values) */
const seedreamVersionOptions = [
  { label: 'v3', value: seedreamVersionIds.v3 },
  { label: 'v4', value: seedreamVersionIds.v4 },
  { label: 'v4.5', value: seedreamVersionIds['v4.5'] },
];

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Seedream aspect ratios */
const seedreamAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Seedream Graph V2
// =============================================================================

/**
 * Seedream family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Seedream doesn't use negative prompts, samplers, steps, or CLIP skip.
 */
export const seedreamGraph = new DataGraph<
  { baseModel: string; workflow: string },
  GenerationCtx
>()
  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: seedreamVersionOptions,
        defaultModelId: seedreamVersionIds['v4.5'],
      }),
    []
  )
  .node('aspectRatio', aspectRatioNode({ options: seedreamAspectRatios, defaultValue: '1:1' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 1,
      max: 20,
      defaultValue: 5,
    })
  )
  .node('seed', seedNode());

// Export version options for use in components
export { seedreamVersionOptions, seedreamVersionIds };
