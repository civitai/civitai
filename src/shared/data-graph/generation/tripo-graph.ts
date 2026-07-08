/**
 * Tripo Graph
 *
 * Controls for the Tripo (via Fal) 3D-model generation ecosystem. Tripo is
 * image-to-3D only, so — unlike the PolyGen (Meshy) graph — there is no
 * `process` discriminator and no text-to-3D subgraph. It rides the shared
 * `img2model3d` workflow alongside PolyGen and Hunyuan3D; the active ecosystem
 * is chosen via the `BaseModelInput` picker.
 *
 * The handler (`tripo-graph.handler.ts`) consumes the validated snapshot and
 * emits a `PolyGenStepTemplate` matching `tripo.schema.ts`. Node names match
 * the schema field names 1:1 (none collide with existing form Controllers), so
 * the handler needs no field remapping.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { enumNode, seedNode } from './common';

// =============================================================================
// Constants
// =============================================================================

export const tripoTextureOptions = [
  { label: 'None', value: 'no' as const },
  { label: 'Standard', value: 'standard' as const },
  { label: 'HD', value: 'HD' as const },
];

export const tripoTextureAlignmentOptions = [
  { label: 'Original image', value: 'original_image' as const },
  { label: 'Geometry', value: 'geometry' as const },
];

export const tripoOrientationOptions = [
  { label: 'Default', value: 'default' as const },
  { label: 'Align to image', value: 'align_image' as const },
];

const TRIPO_MIN_FACE_LIMIT = 1_000;
const TRIPO_MAX_FACE_LIMIT = 500_000;

// =============================================================================
// Source image schema (image-to-3D)
// =============================================================================

const tripoSourceImageSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
});

export type TripoSourceImage = z.infer<typeof tripoSourceImageSchema>;

// =============================================================================
// Tripo Graph
// =============================================================================

type TripoCtx = { ecosystem: string; workflow: string };

export const tripoGraph = new DataGraph<TripoCtx, GenerationCtx>()
  .node('sourceImage', {
    input: tripoSourceImageSchema.optional(),
    output: tripoSourceImageSchema,
    defaultValue: undefined,
    meta: { required: true },
  })
  .node('texture', enumNode({ options: tripoTextureOptions, defaultValue: 'standard' }))
  .node('pbr', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('quad', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('autoSize', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  // Optional — when omitted Tripo auto-selects the face count. Rendered as a
  // clearable number input; empty ⇒ undefined ⇒ auto.
  .node('faceLimit', {
    input: z.coerce.number().int().min(TRIPO_MIN_FACE_LIMIT).max(TRIPO_MAX_FACE_LIMIT).optional(),
    output: z.number().int().min(TRIPO_MIN_FACE_LIMIT).max(TRIPO_MAX_FACE_LIMIT).optional(),
    defaultValue: undefined,
    meta: { min: TRIPO_MIN_FACE_LIMIT, max: TRIPO_MAX_FACE_LIMIT, placeholder: 'Auto' },
  })
  .node(
    'textureAlignment',
    enumNode({ options: tripoTextureAlignmentOptions, defaultValue: 'original_image' })
  )
  .node('orientation', enumNode({ options: tripoOrientationOptions, defaultValue: 'default' }))
  .node('seed', seedNode())
  .node('textureSeed', seedNode());

export type TripoGraphCtx = ReturnType<typeof tripoGraph.init>;

export { TRIPO_MIN_FACE_LIMIT, TRIPO_MAX_FACE_LIMIT };
