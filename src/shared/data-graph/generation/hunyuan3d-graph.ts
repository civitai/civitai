/**
 * Hunyuan3D Graph
 *
 * Controls for the Hunyuan3D (via Comfy) 3D-model generation ecosystem.
 * Hunyuan3D is image-to-3D only, so — like Tripo and unlike PolyGen (Meshy) —
 * there is no `process` discriminator. It rides the shared `img2model3d`
 * workflow; the active ecosystem is chosen via the `BaseModelInput` picker.
 *
 * The handler (`hunyuan3d-graph.handler.ts`) consumes the validated snapshot
 * and emits a `PolyGenStepTemplate` matching `hunyuan3d.schema.ts`.
 *
 * Node names are prefixed `hunyuan*` for the fields whose bare names
 * (`prompt`, `steps`, `cfgScale`, `modelVersion`) collide with the standard
 * image Controllers in `GenerationForm.tsx` — the prefix keeps a dedicated,
 * self-contained Hunyuan3D block. `sourceImage` and `seed` reuse the shared
 * generic Controllers. The handler maps the prefixed names back to schema
 * field names before calling `toHunyuan3dPolyGenInput`.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { enumNode, imagesNode, seedNode, sliderNode, textNode } from './common';

// =============================================================================
// Constants
// =============================================================================

export const hunyuan3dModelVersionOptions = [
  { label: 'v2.1', value: 'v2.1' as const },
  { label: 'v2', value: 'v2' as const },
  { label: 'v2 Mini', value: 'v2-mini' as const },
];

export const hunyuan3dOctreeResolutionOptions = [
  { label: '256', value: 256 },
  { label: '384', value: 384 },
  { label: '512', value: 512 },
];

const HUNYUAN3D_MIN_STEPS = 10;
const HUNYUAN3D_MAX_STEPS = 50;
const HUNYUAN3D_DEFAULT_STEPS = 30;

const HUNYUAN3D_MIN_CFG_SCALE = 0;
const HUNYUAN3D_MAX_CFG_SCALE = 20;
const HUNYUAN3D_DEFAULT_CFG_SCALE = 5;

const HUNYUAN3D_MAX_PROMPT_LENGTH = 600;

// =============================================================================
// Hunyuan3D Graph
// =============================================================================

type Hunyuan3dCtx = { ecosystem: string; workflow: string };

export const hunyuan3dGraph = new DataGraph<Hunyuan3dCtx, GenerationCtx>()
  // Image-to-3D source — the standard `images` node (min/max 1), matching the
  // polygen graph's img2model3d convention. The handler reads `images[0]`.
  .node(
    'images',
    imagesNode({
      min: 1,
      max: 1,
      label: 'Starting image',
      description: 'The reference Hunyuan3D will use to build the 3D mesh',
    })
  )
  // Optional texture/style hint — Hunyuan3D derives geometry from the image.
  .node(
    'hunyuanPrompt',
    textNode({
      name: 'hunyuanPrompt',
      required: false,
      maxLength: HUNYUAN3D_MAX_PROMPT_LENGTH,
      placeholder: 'Optional style/texture hint…',
    })
  )
  .node(
    'hunyuanModelVersion',
    enumNode({ options: hunyuan3dModelVersionOptions, defaultValue: 'v2.1' })
  )
  .node('shouldTexture', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  })
  .node('shouldRemesh', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  })
  .node('enablePbr', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node(
    'hunyuanSteps',
    sliderNode({
      min: HUNYUAN3D_MIN_STEPS,
      max: HUNYUAN3D_MAX_STEPS,
      step: 1,
      defaultValue: HUNYUAN3D_DEFAULT_STEPS,
    })
  )
  .node(
    'hunyuanCfgScale',
    sliderNode({
      min: HUNYUAN3D_MIN_CFG_SCALE,
      max: HUNYUAN3D_MAX_CFG_SCALE,
      step: 0.5,
      defaultValue: HUNYUAN3D_DEFAULT_CFG_SCALE,
    })
  )
  .node(
    'hunyuanOctreeResolution',
    enumNode({ options: hunyuan3dOctreeResolutionOptions, defaultValue: 256 })
  )
  .node('seed', seedNode());

export type Hunyuan3dGraphCtx = ReturnType<typeof hunyuan3dGraph.init>;

export {
  HUNYUAN3D_MIN_STEPS,
  HUNYUAN3D_MAX_STEPS,
  HUNYUAN3D_DEFAULT_STEPS,
  HUNYUAN3D_MIN_CFG_SCALE,
  HUNYUAN3D_MAX_CFG_SCALE,
  HUNYUAN3D_DEFAULT_CFG_SCALE,
};
