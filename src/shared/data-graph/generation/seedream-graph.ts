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
import { aspectRatioNode, cfgScaleNode, createCheckpointGraph, seedNode } from './common';

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

/** Standard Seedream aspect ratios */
const seedreamSizes = [
  { label: '16:9', value: '16:9', width: 2560, height: 1440 },
  { label: '4:3', value: '4:3', width: 2304, height: 1728 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '3:4', value: '3:4', width: 1728, height: 2304 },
  { label: '9:16', value: '9:16', width: 1440, height: 2560 },
];

/** 4K Seedream aspect ratios (v4.5 only) */
const seedreamSizes4K = [
  { label: '16:9', value: '16:9', width: 4096, height: 2304 },
  { label: '4:3', value: '4:3', width: 4096, height: 3072 },
  { label: '1:1', value: '1:1', width: 4096, height: 4096 },
  { label: '3:4', value: '3:4', width: 3072, height: 4096 },
  { label: '9:16', value: '9:16', width: 2304, height: 4096 },
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
export const seedreamGraph = new DataGraph<{ baseModel: string; workflow: string }, GenerationCtx>()
  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: seedreamVersionOptions,
        defaultModelId: seedreamVersionIds['v4.5'],
      }),
    []
  )
  // Aspect ratio depends on model version - 4K sizes for v4.5, standard for others
  .node(
    'aspectRatio',
    (ctx) => {
      const is4K = ctx.model?.id === seedreamVersionIds['v4.5'];
      const options = is4K ? seedreamSizes4K : seedreamSizes;
      return aspectRatioNode({ options, defaultValue: '1:1' });
    },
    ['model']
  )
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
