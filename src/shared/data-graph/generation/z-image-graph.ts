/**
 * ZImage Family Graph V2
 *
 * Controls for ZImageTurbo and ZImageBase ecosystems.
 * Meta contains only dynamic props - static props defined in components.
 *
 * ZImage variants:
 * - Turbo: Fast generation with fixed sampler/scheduler
 * - Base: Full controls with customizable sampler/scheduler
 *
 * Uses SdCpp samplers (euler, heun) and schedulers (simple, discrete).
 * Supports LoRA resources.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  controlNetsNode,
  CONTROLNET_LIMIT,
  createCheckpointGraph,
  createResourcesGraph,
  negativePromptGraph,
  promptGraph,
  samplerNode,
  schedulerNode,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';
import { sdxlAspectRatioBuckets } from '~/shared/constants/generation.constants';
import { zImageControlNetPreprocessors } from '~/shared/constants/controlnets.constants';

// =============================================================================
// ZImage Mode Constants
// =============================================================================

/** ZImage mode type */
export type ZImageMode = 'turbo' | 'base';

/** ZImage model version IDs */
const zImageVersionIds = {
  turbo: 2442439,
  base: 2635223,
} as const;

/** Options for ZImage model selector (using version IDs as values) */
const zImageModeVersionOptions = [
  { label: 'Turbo', value: zImageVersionIds.turbo },
  { label: 'Base', value: zImageVersionIds.base },
];

// =============================================================================
// Sampler / Scheduler Options (SdCpp)
// =============================================================================

/** ZImage sampler options (SdCppSampleMethod) */
const zImageSamplers = ['euler', 'heun'] as const;

/** ZImage scheduler options (SdCppSchedule) */
const zImageSchedules = ['simple', 'discrete'] as const;

// =============================================================================
// Mode Subgraphs
// =============================================================================

/** Context shape passed to zImage mode subgraphs */
type ZImageModeCtx = {
  ecosystem: string;
  workflow: string;
  zImageMode: ZImageMode;
};

/**
 * Turbo mode subgraph: resources + basic controls (no sampler/scheduler)
 * For ZImageTurbo variant
 */
const turboModeGraph = new DataGraph<ZImageModeCtx, GenerationCtx>()
  .merge(createResourcesGraph())
  .node('aspectRatio', aspectRatioNode({ options: sdxlAspectRatioBuckets, defaultValue: '1:1' }))
  .node('cfgScale', sliderNode({ min: 1, max: 2, step: 0.1, defaultValue: 1 }))
  .node('steps', sliderNode({ min: 1, max: 15, defaultValue: 9 }))
  // ControlNets — only available for txt2img workflows.
  .node(
    'controlNets',
    () => ({
      ...controlNetsNode({ preprocessors: zImageControlNetPreprocessors, limit: CONTROLNET_LIMIT }),
      // Disabled for now (was: ctx.workflow === 'txt2img').
      when: false,
    }),
    ['workflow']
  )
  .node('seed', seedNode());

/**
 * Base mode subgraph: resources + full controls including sampler/scheduler
 * For ZImageBase variant
 */
const baseModeGraph = new DataGraph<ZImageModeCtx, GenerationCtx>()
  .merge(createResourcesGraph())
  .merge(negativePromptGraph)
  .node('aspectRatio', aspectRatioNode({ options: sdxlAspectRatioBuckets, defaultValue: '1:1' }))
  .node('sampler', samplerNode({ options: zImageSamplers, defaultValue: 'euler' }))
  .node('scheduler', schedulerNode({ options: zImageSchedules, defaultValue: 'simple' }))
  .node('cfgScale', sliderNode({ min: 1, max: 10, step: 0.5, defaultValue: 4 }))
  .node('steps', sliderNode({ min: 1, max: 50, defaultValue: 20 }))
  // ControlNets — only available for txt2img workflows.
  .node(
    'controlNets',
    () => ({
      ...controlNetsNode({ preprocessors: zImageControlNetPreprocessors, limit: CONTROLNET_LIMIT }),
      // Disabled for now (was: ctx.workflow === 'txt2img').
      when: false,
    }),
    ['workflow']
  )
  .node('seed', seedNode());

// =============================================================================
// ZImage Graph V2
// =============================================================================

/**
 * ZImage family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Uses groupedDiscriminator on 'zImageMode' computed from baseModel:
 * - turbo: basic controls (no sampler/scheduler)
 * - base: full controls (sampler/scheduler exposed)
 *
 * Uses SdCpp samplers/schedulers. Supports LoRA resources.
 */
export const zImageGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  // Merge checkpoint graph with version options (defaultModelId inferred from baseModel)
  .merge(
    createCheckpointGraph({
      versions: { options: zImageModeVersionOptions },
    })
  )
  // Computed: derive zImage mode from baseModel
  .computed(
    'zImageMode',
    (ctx): ZImageMode => {
      switch (ctx.ecosystem) {
        case 'ZImageBase':
          return 'base';
        case 'ZImageTurbo':
        default:
          return 'turbo';
      }
    },
    ['ecosystem']
  )
  // Grouped discriminator: turbo (no sampler/scheduler) and base (full controls)
  .groupedDiscriminator('zImageMode', [
    { values: ['turbo'] as const, graph: turboModeGraph },
    { values: ['base'] as const, graph: baseModeGraph },
  ])
  // Prompt + triggerWords are common to both turbo and base. negativePrompt
  // is only in the base branch; its registration effect adds itself to the
  // snippets target map when that branch is active.
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);

// Export mode options for use in components
export { zImageModeVersionOptions, zImageVersionIds };
