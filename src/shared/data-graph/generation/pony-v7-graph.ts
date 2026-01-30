/**
 * Pony V7 Family Graph V2
 *
 * Controls for PonyV7 ecosystem (based on AuraFlow architecture).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Note: Pony V7 works best with 40+ steps.
 * No negative prompts, samplers, or CLIP skip.
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
  seedNode,
  stepsNode,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Pony V7 model version ID */
const ponyV7VersionId = 2152373;

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Pony V7 aspect ratios (1024px based) */
const ponyV7AspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Guidance Presets
// =============================================================================

/** Pony V7 guidance presets */
const ponyV7GuidancePresets = [
  { label: 'Low', value: 2 },
  { label: 'Balanced', value: 3.5 },
  { label: 'High', value: 7 },
];

// =============================================================================
// Pony V7 Graph V2
// =============================================================================

/**
 * Pony V7 family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Pony V7 doesn't use negative prompts, samplers, or CLIP skip.
 * This model works best with 40+ steps.
 */
export const ponyV7Graph = new DataGraph<
  { baseModel: string; workflow: string },
  GenerationCtx
>()
  // Merge checkpoint graph
  .merge(
    () =>
      createCheckpointGraph({
        defaultModelId: ponyV7VersionId,
      }),
    []
  )
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        limit: ext.limits.maxResources,
      }),
    ['baseModel']
  )
  .node('aspectRatio', aspectRatioNode({ options: ponyV7AspectRatios, defaultValue: '1:1' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 2,
      max: 20,
      defaultValue: 3.5,
      presets: ponyV7GuidancePresets,
    })
  )
  .node(
    'steps',
    stepsNode({
      min: 20,
      max: 50,
      defaultValue: 40, // Pony V7 works best with 40+ steps
    })
  )
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());
