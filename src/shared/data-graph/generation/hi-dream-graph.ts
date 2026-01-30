/**
 * HiDream Family Graph V2
 *
 * Controls for HiDream ecosystem.
 * Meta contains only dynamic props - static props defined in components.
 *
 * HiDream has variants and precisions that affect available controls:
 * - Variants: fast, dev, full
 * - Precisions: fp8, fp16
 *
 * Control availability by variant:
 * - fast: cfgScale=1 (locked), no negativePrompt, sampler=LCM (locked), steps=16
 * - dev: cfgScale=1 (locked), no negativePrompt, sampler=LCM (locked), steps=28
 * - full: cfgScale=5, negativePrompt available, sampler=UniPC, steps=50
 *
 * Note: Supports LoRA resources. No CLIP skip.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  cfgScaleNode,
  createCheckpointGraph,
  negativePromptNode,
  resourcesNode,
  samplerNode,
  seedNode,
  stepsNode,
  type ResourceData,
} from './common';

// =============================================================================
// HiDream Variant/Precision Constants
// =============================================================================

/** HiDream precision type */
export type HiDreamPrecision = 'fp8' | 'fp16';

/** HiDream variant type */
export type HiDreamVariant = 'fast' | 'dev' | 'full';

/** HiDream resource mapping */
const hiDreamResources = [
  { id: 1772448, variant: 'full' as const, precision: 'fp8' as const },
  { id: 1771369, variant: 'dev' as const, precision: 'fp8' as const },
  { id: 1770945, variant: 'fast' as const, precision: 'fp8' as const },
  { id: 1768354, variant: 'full' as const, precision: 'fp16' as const },
  { id: 1769068, variant: 'dev' as const, precision: 'fp16' as const },
  { id: 1768731, variant: 'fast' as const, precision: 'fp16' as const },
];

/** Map from version ID to variant */
const versionIdToVariant = new Map<number, HiDreamVariant>(
  hiDreamResources.map((r) => [r.id, r.variant])
);

/** Options for precision selector */
const precisionOptions = [
  { label: 'FP8', value: 'fp8' },
  { label: 'FP16', value: 'fp16' },
];

/** Options for variant selector (depends on precision) */
const variantOptionsByPrecision: Record<HiDreamPrecision, Array<{ label: string; value: string }>> =
  {
    fp8: [
      { label: 'Fast', value: 'fast' },
      { label: 'Dev', value: 'dev' },
      { label: 'Full', value: 'full' },
    ],
    fp16: [
      { label: 'Fast', value: 'fast' },
      { label: 'Dev', value: 'dev' },
    ],
  };

/** Version options for checkpoint selector (all variants/precisions) */
const hiDreamVersionOptions = hiDreamResources.map((r) => ({
  label: `${r.precision.toUpperCase()} ${r.variant}`,
  value: r.id,
}));

// =============================================================================
// Aspect Ratios
// =============================================================================

/** HiDream aspect ratios (1024px based) */
const hiDreamAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Variant Subgraphs
// =============================================================================

/** Context shape passed to HiDream variant subgraphs */
type HiDreamVariantCtx = {
  baseModel: string;
  workflow: string;
  model: ResourceData;
  hiDreamVariant: HiDreamVariant;
};

/**
 * Fast/Dev mode subgraph: no negative prompt, fixed CFG/sampler/steps
 * Controls are mostly locked in these modes
 */
const fastDevModeGraph = new DataGraph<HiDreamVariantCtx, GenerationCtx>()
  .node('aspectRatio', aspectRatioNode({ options: hiDreamAspectRatios, defaultValue: '1:1' }))
  .node('seed', seedNode());

/**
 * Full mode subgraph: negative prompt available, configurable CFG/sampler/steps
 */
const fullModeGraph = new DataGraph<HiDreamVariantCtx, GenerationCtx>()
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        limit: ext.limits.maxResources,
      }),
    ['baseModel']
  )
  .node('aspectRatio', aspectRatioNode({ options: hiDreamAspectRatios, defaultValue: '1:1' }))
  .node('negativePrompt', negativePromptNode())
  .node(
    'sampler',
    samplerNode({
      options: ['UniPC'],
      defaultValue: 'UniPC',
    })
  )
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 1,
      max: 20,
      defaultValue: 5,
    })
  )
  .node(
    'steps',
    stepsNode({
      min: 20,
      max: 100,
      defaultValue: 50,
    })
  )
  .node('seed', seedNode());

// =============================================================================
// HiDream Graph V2
// =============================================================================

/**
 * HiDream family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Uses discriminatedUnion on 'hiDreamVariant' computed from model.id:
 * - fast/dev: aspectRatio, seed (other controls locked/hidden)
 * - full: resources, aspectRatio, negativePrompt, sampler, cfgScale, steps, seed
 */
export const hiDreamGraph = new DataGraph<
  { baseModel: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: hiDreamVersionOptions,
        defaultModelId: 1771369, // fp8 dev as default
      }),
    []
  )
  // Computed: derive HiDream variant from model.id (version ID)
  .computed(
    'hiDreamVariant',
    (ctx): HiDreamVariant => {
      const modelId = ctx.model?.id;
      if (modelId) {
        const variant = versionIdToVariant.get(modelId);
        if (variant) return variant;
      }
      return 'dev'; // Default to dev if unknown
    },
    ['model']
  )
  // Discriminated union based on hiDreamVariant
  .discriminator('hiDreamVariant', {
    fast: fastDevModeGraph,
    dev: fastDevModeGraph,
    full: fullModeGraph,
  });

// Export for use in components
export {
  hiDreamVersionOptions,
  hiDreamResources,
  precisionOptions,
  variantOptionsByPrecision,
};
