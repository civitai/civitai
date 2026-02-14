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
  cfgScaleNode,
  createCheckpointGraph,
  enhancedCompatibilityNode,
  resourcesNode,
  samplerNode,
  schedulerNode,
  seedNode,
  stepsNode,
} from './common';

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
// Aspect Ratios
// =============================================================================

/** ZImage aspect ratios (1024px based) */
const zImageAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

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
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: ext.limits.maxResources,
      }),
    ['ecosystem']
  )
  .node('aspectRatio', aspectRatioNode({ options: zImageAspectRatios, defaultValue: '1:1' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 1,
      max: 2,
      step: 0.1,
      defaultValue: 1,
    })
  )
  .node(
    'steps',
    stepsNode({
      min: 1,
      max: 15,
      defaultValue: 9,
    })
  )
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());

/**
 * Base mode subgraph: resources + full controls including sampler/scheduler
 * For ZImageBase variant
 */
const baseModeGraph = new DataGraph<ZImageModeCtx, GenerationCtx>()
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: ext.limits.maxResources,
      }),
    ['ecosystem']
  )
  .node('aspectRatio', aspectRatioNode({ options: zImageAspectRatios, defaultValue: '1:1' }))
  .node('sampler', samplerNode({ options: zImageSamplers, defaultValue: 'euler' }))
  .node('scheduler', schedulerNode({ options: zImageSchedules, defaultValue: 'simple' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 1,
      max: 10,
      step: 0.5,
      defaultValue: 4,
    })
  )
  .node(
    'steps',
    stepsNode({
      min: 1,
      max: 50,
      defaultValue: 20,
    })
  )
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());

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
      versions: zImageModeVersionOptions,
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
  ]);

// Export mode options for use in components
export { zImageModeVersionOptions, zImageVersionIds };
