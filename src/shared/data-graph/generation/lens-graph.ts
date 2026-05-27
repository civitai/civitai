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

/**
 * Lens aspect ratios — sized to a ~1440² total-pixel target (base_resolution=1440
 * from the model card), rounded to the nearest multiple of 16.
 */
const lensAspectRatios = [
  { label: '1:2', value: '1:2', width: 1024, height: 2032 },
  { label: '9:16', value: '9:16', width: 1088, height: 1920 },
  { label: '2:3', value: '2:3', width: 1184, height: 1760 },
  { label: '3:4', value: '3:4', width: 1248, height: 1664 },
  { label: '1:1', value: '1:1', width: 1440, height: 1440 },
  { label: '4:3', value: '4:3', width: 1664, height: 1248 },
  { label: '3:2', value: '3:2', width: 1760, height: 1184 },
  { label: '16:9', value: '16:9', width: 1920, height: 1088 },
  { label: '2:1', value: '2:1', width: 2032, height: 1024 },
];

/** The most common aspect ratios — shown before the "More" overflow in the UI. */
const lensPriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// =============================================================================
// Variant Subgraphs
// =============================================================================

/** Normal model: cfg 5.0, steps 20 (model card defaults), LoRA support */
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
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 5, step: 0.5 }))
  .node('steps', sliderNode({ min: 1, max: 50, defaultValue: 20 }));

/** Turbo model: same defaults as normal per model card, LoRA support */
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
  .node('cfgScale', sliderNode({ min: 1, max: 2, step: 0.1, defaultValue: 1 }))
  .node('steps', sliderNode({ min: 1, max: 12, defaultValue: 4 }));

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
  .node(
    'aspectRatio',
    aspectRatioNode({
      options: lensAspectRatios,
      defaultValue: '1:1',
      priorityOptions: lensPriorityRatios,
    })
  )
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph)
  .node('seed', seedNode());
