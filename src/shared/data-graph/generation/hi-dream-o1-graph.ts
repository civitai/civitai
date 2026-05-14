/**
 * HiDream-O1 Family Graph
 *
 * Controls for HiDream-O1 ecosystem (HiDream.ai).
 *
 * Two model variants discriminate cfgScale + steps defaults:
 * - Full (HiDream-O1-Image):     cfg 4.5, 50 steps
 * - Dev  (HiDream-O1-Image-dev): cfg 1   (distilled), 28 steps
 *
 * Supports both image:create (txt2img) and image:edit (img2img:edit) — the images
 * node is shown only for the edit workflow. LoRAs are supported on both variants.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ResourceData } from './common';
import {
  aspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  enumNode,
  imagesNode,
  negativePromptGraph,
  promptGraph,
  seedNode,
  sliderNode,
  triggerWordsGraph,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** HiDream-O1 version IDs */
export const hiDreamO1VersionIds = {
  full: 2939946,
  dev: 2939964,
} as const;

type HiDreamO1Variant = 'full' | 'dev';

const hiDreamO1VersionOptions = [
  { label: 'Full', value: hiDreamO1VersionIds.full },
  { label: 'Dev', value: hiDreamO1VersionIds.dev },
];

/** Map version ID to variant */
const versionIdToVariant = new Map<number, HiDreamO1Variant>([
  [hiDreamO1VersionIds.full, 'full'],
  [hiDreamO1VersionIds.dev, 'dev'],
]);

// =============================================================================
// Variant Subgraphs
// =============================================================================
// Each variant has its own cfgScale + steps defaults. We use a discriminator
// (rather than a single set of nodes with an effect-based reset) so a fresh
// safeParse doesn't trample user-adjusted values — the effect-based approach
// would re-fire on every validation pass because the computed variant is in
// `changed` for every clone.

type HiDreamO1VariantCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData;
  hiDreamO1Variant: HiDreamO1Variant;
};

/** Dev (distilled): cfg=1, 28 steps. */
const devVariantGraph = new DataGraph<HiDreamO1VariantCtx, GenerationCtx>()
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 1, step: 0.5 }))
  .node('steps', sliderNode({ min: 1, max: 100, defaultValue: 28 }));

/** Full: cfg=4.5, 50 steps. */
const fullVariantGraph = new DataGraph<HiDreamO1VariantCtx, GenerationCtx>()
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 4.5, step: 0.5 }))
  .node('steps', sliderNode({ min: 1, max: 100, defaultValue: 50 }));

// =============================================================================
// Resolution + Aspect Ratios
// =============================================================================

type HiDreamO1Resolution = '1K' | '2K';

const hiDreamO1ResolutionOptions = [
  { label: '1K', value: '1K' },
  { label: '2K', value: '2K' },
] as const;

/** HiDream-O1 aspect ratios per resolution tier, all dimensions divisible by 64 */
const hiDreamO1AspectRatiosByResolution: Record<
  HiDreamO1Resolution,
  Array<{ label: string; value: string; width: number; height: number }>
> = {
  '1K': [
    { label: '16:9', value: '16:9', width: 1408, height: 768 },
    { label: '3:2', value: '3:2', width: 1216, height: 832 },
    { label: '4:3', value: '4:3', width: 1152, height: 896 },
    { label: '1:1', value: '1:1', width: 1024, height: 1024 },
    { label: '3:4', value: '3:4', width: 896, height: 1152 },
    { label: '2:3', value: '2:3', width: 832, height: 1216 },
    { label: '9:16', value: '9:16', width: 768, height: 1408 },
  ],
  '2K': [
    { label: '16:9', value: '16:9', width: 2816, height: 1536 },
    { label: '3:2', value: '3:2', width: 2432, height: 1664 },
    { label: '4:3', value: '4:3', width: 2304, height: 1792 },
    { label: '1:1', value: '1:1', width: 2048, height: 2048 },
    { label: '3:4', value: '3:4', width: 1792, height: 2304 },
    { label: '2:3', value: '2:3', width: 1664, height: 2432 },
    { label: '9:16', value: '9:16', width: 1536, height: 2816 },
  ],
};

// =============================================================================
// HiDream-O1 Graph
// =============================================================================

export const hiDreamO1Graph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
  // Images node — required for img2img:edit, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ min: 1, max: 4 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Checkpoint selector (Full vs Dev)
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: hiDreamO1VersionOptions },
        defaultModelId: hiDreamO1VersionIds.dev,
      }),
    []
  )
  // Computed variant — drives the discriminator below
  .computed(
    'hiDreamO1Variant',
    (ctx) => (ctx.model?.id ? versionIdToVariant.get(ctx.model.id) : undefined) ?? 'dev',
    ['model']
  )
  // Variant-specific defaults for cfgScale + steps (dev is distilled, cfg=1)
  .discriminator('hiDreamO1Variant', {
    dev: devVariantGraph,
    full: fullVariantGraph,
  })
  // LoRA resources — both variants support LoRAs
  .merge(createResourcesGraph())
  .node('resolution', enumNode({ options: hiDreamO1ResolutionOptions, defaultValue: '1K' }))
  // Aspect ratio dimensions follow the selected resolution tier.
  .node(
    'aspectRatio',
    (ctx) =>
      aspectRatioNode({
        options:
          hiDreamO1AspectRatiosByResolution[ctx.resolution as HiDreamO1Resolution] ??
          hiDreamO1AspectRatiosByResolution['2K'],
        defaultValue: '1:1',
      }),
    ['resolution']
  )
  .node('seed', seedNode())
  .merge(triggerWordsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph);
