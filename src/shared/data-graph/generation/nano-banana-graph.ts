/**
 * Nano Banana Family Graph V2
 *
 * Controls for NanoBanana ecosystem (Gemini-based).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Nano Banana has two modes:
 * - Standard (2.5-flash): Basic generation with minimal controls
 * - Pro: Adds negative prompt, aspect ratio, and resolution options
 *
 * Note: No LoRA support, no samplers, CFG scale, steps, or CLIP skip.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  negativePromptNode,
  seedNode,
  type ResourceData,
} from './common';

// =============================================================================
// Nano Banana Mode Constants
// =============================================================================

/** Nano Banana mode type */
export type NanoBananaMode = 'standard' | 'pro';

/** Nano Banana mode version IDs */
const nanoBananaVersionIds = {
  standard: 2154472,
  pro: 2436219,
} as const;

/** Map from version ID to mode name */
const versionIdToMode = new Map<number, NanoBananaMode>(
  Object.entries(nanoBananaVersionIds).map(([mode, id]) => [id, mode as NanoBananaMode])
);

/** Options for nano banana mode selector (using version IDs as values) */
const nanoBananaModeVersionOptions = [
  { label: 'Standard', value: nanoBananaVersionIds.standard },
  { label: 'Pro', value: nanoBananaVersionIds.pro },
];

// =============================================================================
// Aspect Ratios & Resolutions
// =============================================================================

/** Nano Banana Pro aspect ratios */
const nanoBananaProAspectRatios = [
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '4:3', value: '4:3', width: 1440, height: 1080 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:4', value: '3:4', width: 1080, height: 1440 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

/** Resolution options for Nano Banana Pro */
const resolutionOptions = ['1K', '2K', '4K'] as const;

// =============================================================================
// Mode Subgraphs
// =============================================================================

/** Context shape passed to nano banana mode subgraphs */
type NanoBananaModeCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData;
  nanoBananaMode: NanoBananaMode;
};

/** Standard mode subgraph: just seed */
const standardModeGraph = new DataGraph<NanoBananaModeCtx, GenerationCtx>().node(
  'seed',
  seedNode()
);

/** Pro mode subgraph: negativePrompt, aspectRatio, resolution, seed */
const proModeGraph = new DataGraph<NanoBananaModeCtx, GenerationCtx>()
  .node('negativePrompt', negativePromptNode())
  .node('aspectRatio', aspectRatioNode({ options: nanoBananaProAspectRatios, defaultValue: '1:1' }))
  .node('resolution', {
    input: z.enum(resolutionOptions).optional(),
    output: z.enum(resolutionOptions),
    defaultValue: '1K',
    meta: {
      options: resolutionOptions.map((r) => ({ label: r, value: r })),
    },
  })
  .node('seed', seedNode());

// =============================================================================
// Nano Banana Graph V2
// =============================================================================

/**
 * Nano Banana family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Uses discriminatedUnion on 'nanoBananaMode' computed from model.id:
 * - standard: seed only
 * - pro: negativePrompt, aspectRatio, resolution, seed
 */
export const nanoBananaGraph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: nanoBananaModeVersionOptions,
        defaultModelId: nanoBananaVersionIds.standard,
      }),
    []
  )
  // Computed: derive nano banana mode from model.id (version ID)
  .computed(
    'nanoBananaMode',
    (ctx): NanoBananaMode => {
      const modelId = ctx.model?.id;
      if (modelId) {
        const mode = versionIdToMode.get(modelId);
        if (mode) return mode;
      }
      return 'standard'; // Default to standard if unknown
    },
    ['model']
  )
  // Discriminated union based on nanoBananaMode
  .discriminator('nanoBananaMode', {
    standard: standardModeGraph,
    pro: proModeGraph,
  });

// Export mode options for use in components
export { nanoBananaModeVersionOptions, nanoBananaVersionIds };
