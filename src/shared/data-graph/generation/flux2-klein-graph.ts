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
  sdxlFullAspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  imagesNode,
  negativePromptGraph,
  promptGraph,
  samplerNode,
  schedulerNode,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
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
  .merge(createResourcesGraph())
  .node('aspectRatio', sdxlFullAspectRatioNode())
  .merge(negativePromptGraph)
  .node('steps', sliderNode({ min: 4, max: 12, defaultValue: 8 }))
  .node('seed', seedNode());

/**
 * Base mode subgraph: resources + full controls
 * For 9B Base and 4B Base variants
 */
const baseModeGraph = new DataGraph<Flux2KleinModeCtx, GenerationCtx>()
  .merge(createResourcesGraph())
  .node('aspectRatio', sdxlFullAspectRatioNode())
  .merge(negativePromptGraph)
  .node('sampler', samplerNode({ options: flux2KleinSamplers, defaultValue: 'euler' }))
  .node('scheduler', schedulerNode({ options: flux2KleinSchedules, defaultValue: 'simple' }))
  .node('cfgScale', sliderNode({ min: 2, max: 20, defaultValue: 7, step: 0.5 }))
  .node('steps', sliderNode({ min: 20, max: 50, defaultValue: 30 }))
  .node('seed', seedNode());

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
      versions: { options: flux2KleinModeVersionOptions },
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
  ])
  // Prompt + triggerWords are common to all flux2Klein variants. negativePrompt
  // is merged inside each mode branch — its `createTextEditorGraph` factory
  // self-registers as a snippets target via its own effect, so the snippets
  // node here can stay generic.
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);

// Export mode options for use in components
export { flux2KleinModeVersionOptions, flux2KleinVersionIds };
