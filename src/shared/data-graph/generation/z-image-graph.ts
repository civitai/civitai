/**
 * ZImage Family Graph V2
 *
 * Controls for ZImageTurbo and ZImageBase ecosystems.
 * Meta contains only dynamic props - static props defined in components.
 *
 * ZImage models are optimized for fast generation with specific parameter ranges:
 * - Steps: 1-15 (turbo mode)
 * - CFG Scale: 1-2 (low guidance for speed)
 *
 * Note: No negative prompts, samplers, or CLIP skip.
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
// Aspect Ratios
// =============================================================================

/** ZImage aspect ratios (1024px based) */
const zImageAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// ZImage Graph V2
// =============================================================================

/**
 * ZImage family controls.
 * Used for ZImageTurbo and ZImageBase ecosystems.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: ZImage doesn't use negative prompts, samplers, or CLIP skip.
 * Uses turbo-optimized parameter ranges for fast generation.
 */
export const zImageGraph = new DataGraph<{ baseModel: string; workflow: string }, GenerationCtx>()
  // Merge checkpoint graph (uses ecosystem settings for default model)
  .merge(createCheckpointGraph())
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        limit: ext.limits.maxResources,
      }),
    ['baseModel']
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
