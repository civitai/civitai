/**
 * Lens Family Graph
 *
 * Controls for the Lens ecosystem (Civitai-internal, comfy engine).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Two models discriminated by lensVariant (computed from model.id):
 * - normal: full-step variant
 * - turbo: low-step variant
 *
 * Both variants support LoRAs.
 * Sampler (euler) and scheduler (simple) are fixed — set in the handler, not exposed in UI.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ResourceData } from './common';
import {
  aspectRatioNode,
  createCheckpointGraph,
  negativePromptGraph,
  promptGraph,
  resourcesNode,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Lens version IDs */
export const lensVersionIds = {
  normal: 2655865,
  turbo: 2982241,
} as const;

type LensVariant = 'normal' | 'turbo';

/** Options for lens version selector (using version IDs as values) */
const lensVersionOptions = [
  { label: 'Normal', value: lensVersionIds.normal },
  { label: 'Turbo', value: lensVersionIds.turbo },
];

/** Map version ID to variant */
const versionIdToVariant = new Map<number, LensVariant>([
  [lensVersionIds.normal, 'normal'],
  [lensVersionIds.turbo, 'turbo'],
]);

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Lens aspect ratios (standard 1024-grade resolutions) */
const lensAspectRatios = [
  { label: '16:9', value: '16:9', width: 1344, height: 768 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '9:16', value: '9:16', width: 768, height: 1344 },
];

// =============================================================================
// Variant Subgraphs
// =============================================================================

/** Normal model: standard cfg/steps, LoRA support */
const normalGraph = new DataGraph<{ ecosystem: string }, GenerationCtx>()
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

/** Turbo model: low cfg/steps, LoRA support */
const turboGraph = new DataGraph<{ ecosystem: string }, GenerationCtx>()
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: ext.limits.maxResources,
      }),
    ['ecosystem']
  )
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 1, step: 0.5 }))
  .node('steps', sliderNode({ min: 1, max: 50, defaultValue: 8 }));

// =============================================================================
// Lens Graph
// =============================================================================

/**
 * Lens family controls.
 *
 * Discriminates on lensVariant (computed from model.id) to select normal vs turbo subgraph.
 */
export const lensGraph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: lensVersionOptions },
        defaultModelId: lensVersionIds.normal,
      }),
    []
  )
  .computed(
    'lensVariant',
    (ctx) => (ctx.model?.id ? versionIdToVariant.get(ctx.model.id) : undefined) ?? 'normal',
    ['model']
  )
  .discriminator('lensVariant', {
    normal: normalGraph,
    turbo: turboGraph,
  })
  // Reset cfgScale and steps to variant defaults when switching models.
  // The discriminator switches branches, but the form's persisted input values
  // remain valid in the new branch's range, so we explicitly reset them.
  .effect(
    (ctx, _ext, set) => {
      const isTurbo = ctx.lensVariant === 'turbo';
      set('cfgScale', isTurbo ? 1 : 4);
      set('steps', isTurbo ? 8 : 20);
    },
    ['lensVariant']
  )
  .node('aspectRatio', aspectRatioNode({ options: lensAspectRatios, defaultValue: '1:1' }))
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph)
  .node('seed', seedNode());
