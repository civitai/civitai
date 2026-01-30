/**
 * Qwen Family Graph V2
 *
 * Controls for Qwen ecosystem.
 * Meta contains only dynamic props - static props defined in components.
 *
 * Note: Qwen doesn't use negative prompts, samplers, or CLIP skip.
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

/** Qwen aspect ratios (1024px based) */
const qwenAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Qwen Graph V2
// =============================================================================

/**
 * Qwen family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Qwen doesn't use negative prompts, samplers, or CLIP skip.
 */
export const qwenGraph = new DataGraph<{ baseModel: string; workflow: string }, GenerationCtx>()
  // Merge checkpoint graph (includes model node and baseModel sync effect)
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
  .node('aspectRatio', aspectRatioNode({ options: qwenAspectRatios, defaultValue: '1:1' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 2,
      max: 20,
      defaultValue: 3.5,
    })
  )
  .node('steps', stepsNode({ min: 20, max: 50 }))
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());
