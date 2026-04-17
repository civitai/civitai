/**
 * Ernie Family Graph
 *
 * Controls for Ernie ecosystem (Baidu).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Two models discriminated by ernieVariant (computed from model.id):
 * - base: guidance 4.0, steps 20, supports LoRAs
 * - turbo: guidance 1.0, steps 8, no LoRA support
 *
 * Sampler (euler) and scheduler (simple) are fixed — set in the handler, not exposed in UI.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ResourceData } from './common';
import {
  aspectRatioNode,
  createCheckpointGraph,
  negativePromptNode,
  resourcesNode,
  seedNode,
  sliderNode,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Ernie version IDs */
export const ernieVersionIds = {
  ernie: 2863858,
  turbo: 2863892,
} as const;

type ErnieVariant = 'base' | 'turbo';

/** Options for ernie version selector (using version IDs as values) */
const ernieVersionOptions = [
  { label: 'Ernie', value: ernieVersionIds.ernie },
  { label: 'Turbo', value: ernieVersionIds.turbo },
];

/** Map version ID to variant */
const versionIdToVariant = new Map<number, ErnieVariant>([
  [ernieVersionIds.ernie, 'base'],
  [ernieVersionIds.turbo, 'turbo'],
]);

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Ernie aspect ratios (from HuggingFace recommended settings) */
const ernieAspectRatios = [
  { label: '16:9', value: '16:9', width: 1376, height: 768 },
  { label: '3:2', value: '3:2', width: 1264, height: 848 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '2:3', value: '2:3', width: 848, height: 1264 },
  { label: '9:16', value: '9:16', width: 768, height: 1376 },
];

// =============================================================================
// Variant Subgraphs
// =============================================================================

/** Base model: guidance 4.0, steps 20, LoRA support */
const baseGraph = new DataGraph<{ ecosystem: string }, GenerationCtx>()
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: ext.limits.maxResources,
      }),
    ['ecosystem']
  )
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 4, step: 0.5 }))
  .node('steps', sliderNode({ min: 1, max: 50, defaultValue: 20 }));

/** Turbo model: guidance 1.0, steps 8, no LoRA support */
const turboGraph = new DataGraph<{ ecosystem: string }, GenerationCtx>()
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 1, step: 0.5 }))
  .node('steps', sliderNode({ min: 1, max: 50, defaultValue: 8 }));

// =============================================================================
// Ernie Graph
// =============================================================================

/**
 * Ernie family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Discriminates on ernieVariant (computed from model.id) to select base vs turbo subgraph.
 */
export const ernieGraph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: ernieVersionOptions },
        defaultModelId: ernieVersionIds.ernie,
      }),
    []
  )
  .computed(
    'ernieVariant',
    (ctx) => (ctx.model?.id ? versionIdToVariant.get(ctx.model.id) : undefined) ?? 'base',
    ['model']
  )
  .discriminator('ernieVariant', {
    base: baseGraph,
    turbo: turboGraph,
  })
  .node('aspectRatio', aspectRatioNode({ options: ernieAspectRatios, defaultValue: '1:1' }))
  .node('negativePrompt', negativePromptNode())
  .node('seed', seedNode());
