/**
 * Chroma Family Graph V2
 *
 * Controls for Chroma ecosystem.
 * Meta contains only dynamic props - static props defined in components.
 *
 * Chroma is an open-source model based on Flux architecture with improved
 * color and composition capabilities.
 *
 * Note: No negative prompts, samplers, or CLIP skip.
 * Supports full addon types (LoRA, DoRA, LoCon, TextualInversion).
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

/** Chroma default model version ID */
const chromaVersionId = 2164239;

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Chroma aspect ratios (1024px based) */
const chromaAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Guidance Presets
// =============================================================================

/** Chroma guidance presets */
const chromaGuidancePresets = [
  { label: 'Low', value: 2 },
  { label: 'Balanced', value: 3.5 },
  { label: 'High', value: 7 },
];

// =============================================================================
// Chroma Graph V2
// =============================================================================

/**
 * Chroma family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Chroma doesn't use negative prompts, samplers, or CLIP skip.
 */
export const chromaGraph = new DataGraph<{ baseModel: string; workflow: string }, GenerationCtx>()
  // Merge checkpoint graph
  .merge(
    () =>
      createCheckpointGraph({
        defaultModelId: chromaVersionId,
      }),
    []
  )
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        resourceIds: ext.resources?.map((x) => x.id) ?? [],
        limit: ext.limits.maxResources,
      }),
    ['baseModel']
  )
  .node('aspectRatio', aspectRatioNode({ options: chromaAspectRatios, defaultValue: '1:1' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 2,
      max: 20,
      defaultValue: 3.5,
      presets: chromaGuidancePresets,
    })
  )
  .node('steps', stepsNode({ min: 20, max: 50 }))
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());
