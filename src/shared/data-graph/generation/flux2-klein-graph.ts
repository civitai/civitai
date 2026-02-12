/**
 * Flux.2 Klein Family Graph
 *
 * Controls for Flux.2 Klein ecosystems (9B, 9B Base, 4B, 4B Base).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Flux.2 Klein variants:
 * - 9B: Distilled 9B model with fixed steps/cfgScale
 * - 9B Base: Full 9B model with customizable params
 * - 4B: Distilled 4B model with fixed steps/cfgScale
 * - 4B Base: Full 4B model with customizable params
 *
 * Supports negative prompts, samplers, and LoRA resources.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  cfgScaleNode,
  createCheckpointGraph,
  enhancedCompatibilityNode,
  imagesNode,
  negativePromptNode,
  resourcesNode,
  samplerNode,
  schedulerNode,
  seedNode,
  stepsNode,
} from './common';

// =============================================================================
// Flux.2 Klein Mode Constants
// =============================================================================

/** Flux.2 Klein mode type */
export type Flux2KleinMode = '9b' | '9b-base' | '4b' | '4b-base';

/** Flux.2 Klein mode version IDs */
const flux2KleinVersionIds = {
  '9b': 2612554,
  '9b-base': 2612548,
  '4b': 2612557,
  '4b-base': 2612552,
} as const;

/** Map from version ID to mode name */
const versionIdToMode = new Map<number, Flux2KleinMode>(
  Object.entries(flux2KleinVersionIds).map(([mode, id]) => [id, mode as Flux2KleinMode])
);

/** Options for flux2 klein mode selector (using version IDs as values) */
const flux2KleinModeVersionOptions = [
  { label: '9B', value: flux2KleinVersionIds['9b'] },
  { label: '9B Base', value: flux2KleinVersionIds['9b-base'] },
  { label: '4B', value: flux2KleinVersionIds['4b'] },
  { label: '4B Base', value: flux2KleinVersionIds['4b-base'] },
];

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Flux.2 Klein aspect ratios (1024px based) */
const flux2KleinAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Sampler Options
// =============================================================================

/** Flux.2 Klein sampler options (SdCppSampleMethod) */
const flux2KleinSamplers = [
  'euler',
  'heun',
  'dpm++2s_a',
  'dpm++2m',
  'dpm++2mv2',
  'ipndm',
  'ipndm_v',
  'lcm',
] as const;

/** Flux.2 Klein scheduler options (SdCppSchedule) */
const flux2KleinSchedules = ['simple', 'discrete', 'karras', 'exponential'] as const;

// =============================================================================
// Mode Subgraphs
// =============================================================================

/** Context shape passed to flux2 klein mode subgraphs */
type Flux2KleinModeCtx = {
  ecosystem: string;
  workflow: string;
  flux2KleinMode: Flux2KleinMode;
};

/**
 * Distilled mode subgraph: resources + aspectRatio + seed (no cfg/steps exposed)
 * For 9B and 4B distilled variants
 */
const distilledModeGraph = new DataGraph<Flux2KleinModeCtx, GenerationCtx>()
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: ext.limits.maxResources,
      }),
    ['ecosystem']
  )
  .node('aspectRatio', aspectRatioNode({ options: flux2KleinAspectRatios, defaultValue: '1:1' }))
  .node('negativePrompt', negativePromptNode())
  .node('steps', stepsNode({ min: 4, max: 12, defaultValue: 8 }))
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());

/**
 * Base mode subgraph: resources + full controls
 * For 9B Base and 4B Base variants
 */
const baseModeGraph = new DataGraph<Flux2KleinModeCtx, GenerationCtx>()
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: ext.limits.maxResources,
      }),
    ['ecosystem']
  )
  .node('aspectRatio', aspectRatioNode({ options: flux2KleinAspectRatios, defaultValue: '1:1' }))
  .node('negativePrompt', negativePromptNode())
  .node('sampler', samplerNode({ options: flux2KleinSamplers, defaultValue: 'euler' }))
  .node('scheduler', schedulerNode({ options: flux2KleinSchedules, defaultValue: 'simple' }))
  .node('cfgScale', cfgScaleNode({ min: 2, max: 20, defaultValue: 7 }))
  .node('steps', stepsNode({ min: 20, max: 50, defaultValue: 30 }))
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());

// =============================================================================
// Flux.2 Klein Graph
// =============================================================================

/**
 * Flux.2 Klein family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Uses discriminatedUnion on 'flux2KleinMode' computed from baseModel:
 * - 9b/4b: distilled mode (no steps/cfgScale)
 * - 9b-base/4b-base: base mode (full controls)
 *
 * Supports negative prompts, samplers, and LoRA resources.
 */
export const flux2KleinGraph = new DataGraph<
  { ecosystem: string; workflow: string },
  GenerationCtx
>()
  // Images node - shown for img2img variants, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 7 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Merge checkpoint graph with version options (defaultModelId inferred from baseModel)
  .merge(
    createCheckpointGraph({
      versions: flux2KleinModeVersionOptions,
    })
  )
  // Computed: derive flux2Klein mode from baseModel
  .computed(
    'flux2KleinMode',
    (ctx): Flux2KleinMode => {
      // Map baseModel to mode
      switch (ctx.ecosystem) {
        case 'Flux2Klein_9B':
          return '9b';
        case 'Flux2Klein_9B_base':
          return '9b-base';
        case 'Flux2Klein_4B':
          return '4b';
        case 'Flux2Klein_4B_base':
          return '4b-base';
        default:
          return '9b'; // Default
      }
    },
    ['ecosystem']
  )
  // Grouped discriminator: distilled (9b/4b) and base (9b-base/4b-base) share graphs
  .groupedDiscriminator('flux2KleinMode', [
    { values: ['9b', '4b'] as const, graph: distilledModeGraph },
    { values: ['9b-base', '4b-base'] as const, graph: baseModeGraph },
  ]);

// Export mode options for use in components
export { flux2KleinModeVersionOptions, flux2KleinVersionIds };
