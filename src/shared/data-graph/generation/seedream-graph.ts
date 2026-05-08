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
  createCheckpointGraph,
  enumNode,
  imagesNode,
  promptGraph,
  seedNode,
  sliderNode,
  triggerWordsGraph,
} from './common';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';

// =============================================================================
// Seedream Version Constants
// =============================================================================

/** Seedream version type */
export type SeedreamVersion = 'v3' | 'v4' | 'v4.5' | 'v5.0-lite';

/** Seedream version IDs */
const seedreamVersionIds = {
  v3: 2208174,
  v4: 2208278,
  'v4.5': 2470991,
  'v5.0-lite': 2720141,
} as const;

/** Options for seedream version selector (using version IDs as values) */
const seedreamVersionOptions = [
  { label: 'v3', value: seedreamVersionIds.v3 },
  { label: 'v4', value: seedreamVersionIds.v4 },
  { label: 'v4.5', value: seedreamVersionIds['v4.5'] },
  { label: 'v5.0 lite', value: seedreamVersionIds['v5.0-lite'] },
];

// =============================================================================
// Aspect Ratios
// =============================================================================

const seedreamAspectRatioList: GenerationAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// =============================================================================
// Resolution Tier
// =============================================================================

const seedreamResolutionOptions = [
  { label: '2K', value: '2K' },
  { label: '4K', value: '4K' },
] as const;

/** Versions that support the 2K/4K resolution toggle */
const versionsWithResolutionToggle = new Set<number>([
  seedreamVersionIds['v4.5'],
  seedreamVersionIds['v5.0-lite'],
]);

const supportsResolutionToggle = (modelId?: number) =>
  modelId !== undefined && versionsWithResolutionToggle.has(modelId);

// =============================================================================
// Seedream Graph V2
// =============================================================================

/**
 * Seedream family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Seedream doesn't use negative prompts, samplers, steps, or CLIP skip.
 */
export const seedreamGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  // Images node - shown for img2img variants, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 7 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: seedreamVersionOptions },
        defaultModelId: seedreamVersionIds['v4.5'],
      }),
    []
  )
  // Resolution toggle (2K/4K) - only shown for versions that support it (v4.5, v5.0-lite)
  .node(
    'resolution',
    (ctx) => ({
      ...enumNode({ options: seedreamResolutionOptions, defaultValue: '4K' }),
      when: supportsResolutionToggle(ctx.model?.id),
    }),
    ['model']
  )
  // Aspect ratio dimensions follow the selected resolution tier (defaults to 2K
  // for versions without a 4K toggle, where ctx.resolution is undefined).
  .node(
    'aspectRatio',
    (ctx) =>
      aspectRatioNode({
        options: getAspectRatioOptions(ctx.resolution ?? '2K', seedreamAspectRatioList),
        defaultValue: '1:1',
      }),
    ['resolution']
  )
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 5, step: 0.5 }))
  .node('seed', seedNode())

  // Prompt + triggerWords (no negativePrompt for Seedream)
  .merge(triggerWordsGraph)
  .merge(promptGraph);

// Export version options for use in components
export { seedreamVersionOptions, seedreamVersionIds };
