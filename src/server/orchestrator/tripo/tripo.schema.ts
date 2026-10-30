/**
 * Tripo Schema (Tripo via Fal)
 *
 * Zod schema for the Tripo 3D-model generation form. Tripo is image-to-3D
 * only (`imageUrl` is required on the client type), so — unlike Meshy — there
 * is no text-to-3D branch and no `process` discriminator.
 *
 * Mirrors `src/server/orchestrator/polygen/polygen.schema.ts`:
 * - `sourceImageSchema` reused for the "URL or upload" pattern.
 * - `toTripoPolyGenInput` converts validated form data to the
 *   `TripoFalPolyGenInput` shape (`engine: 'fal', model: 'tripo'`) consumed by
 *   the graph handler when building the `polyGen` step.
 */

import type {
  TripoFalPolyGenInput,
  TripoH31ImageTo3dFalPolyGenInput,
  TripoH31MultiviewTo3dFalPolyGenInput,
} from '@civitai/orchestration-client';
import * as z from 'zod';
import {
  sourceImageSchema,
  type SourceImageProps,
} from '~/server/orchestrator/infrastructure/base.schema';
import { dropUndefined } from '~/server/orchestrator/polygen/polygen.schema';

// =============================================================================
// Constants
// =============================================================================

export const tripoTextures = ['no', 'standard', 'HD'] as const;
export const tripoTextureAlignments = ['original_image', 'geometry'] as const;
export const tripoOrientations = ['default', 'align_image'] as const;

const MIN_FACE_LIMIT = 1_000;
const MAX_FACE_LIMIT = 500_000;

// =============================================================================
// Schema
// =============================================================================

export const tripoGenerationSchema = z.object({
  sourceImage: sourceImageSchema,
  texture: z.enum(tripoTextures).default('standard'),
  pbr: z.boolean().default(false),
  quad: z.boolean().default(false),
  autoSize: z.boolean().default(false),
  faceLimit: z.number().int().min(MIN_FACE_LIMIT).max(MAX_FACE_LIMIT).optional(),
  textureAlignment: z.enum(tripoTextureAlignments).default('original_image'),
  orientation: z.enum(tripoOrientations).default('default'),
  // Tripo accepts a 32-bit signed int seed; optional so the handler can
  // randomize when omitted.
  seed: z.number().int().min(-2147483648).max(2147483647).optional(),
  textureSeed: z.number().int().min(-2147483648).max(2147483647).optional(),
});
export type TripoGenerationSchema = z.infer<typeof tripoGenerationSchema>;

// =============================================================================
// Helper — convert validated schema to Tripo/Fal PolyGen input shape
// =============================================================================

/**
 * Convert form data to a Tripo/Fal PolyGen input. Used by the graph handler
 * when building the `PolyGenStepTemplate` for `submitWorkflow`.
 */
export function toTripoPolyGenInput(data: TripoGenerationSchema): TripoFalPolyGenInput {
  return dropUndefined({
    engine: 'fal' as const,
    model: 'tripo' as const,
    version: 'v2.5',
    imageUrl: data.sourceImage.url,
    texture: data.texture,
    pbr: data.pbr,
    quad: data.quad,
    autoSize: data.autoSize,
    faceLimit: data.faceLimit,
    textureAlignment: data.textureAlignment,
    orientation: data.orientation,
    seed: data.seed,
    textureSeed: data.textureSeed,
  }) as TripoFalPolyGenInput;
}

// =============================================================================
// Tripo H3.1
// =============================================================================
//
// H3.1 is a `version` of the same Fal model. The form exposes its image and
// multiview operations; the operation is derived from the image count (1 →
// imageTo3D, 2–4 → multiviewTo3D).

export const tripoQualities = ['standard', 'detailed'] as const;
type TripoQuality = (typeof tripoQualities)[number];

export type TripoH31GenerationData = Omit<TripoGenerationSchema, 'sourceImage'> & {
  sourceImages: SourceImageProps[];
  geometryQuality?: TripoQuality;
};

/**
 * H3.1 takes texture on/off plus a texture quality; the form keeps v2.5's
 * single None / Standard / HD control, with HD mapping to detailed quality.
 */
export function toTripoH31PolyGenInput(
  data: TripoH31GenerationData
): TripoH31ImageTo3dFalPolyGenInput | TripoH31MultiviewTo3dFalPolyGenInput {
  const shared = {
    engine: 'fal' as const,
    model: 'tripo' as const,
    version: 'h3.1' as const,
    texture: data.texture !== 'no',
    textureQuality: data.texture === 'HD' ? ('detailed' as const) : ('standard' as const),
    pbr: data.pbr,
    quad: data.quad,
    autoSize: data.autoSize,
    faceLimit: data.faceLimit,
    geometryQuality: data.geometryQuality,
    textureAlignment: data.textureAlignment,
    orientation: data.orientation,
    // H3.1 takes non-negative int32 seeds only.
    seed: data.seed !== undefined && data.seed >= 0 ? data.seed : undefined,
    textureSeed:
      data.textureSeed !== undefined && data.textureSeed >= 0 ? data.textureSeed : undefined,
  };

  if (data.sourceImages.length > 1) {
    return dropUndefined({
      ...shared,
      operation: 'multiviewTo3D' as const,
      imageUrls: data.sourceImages.map((image) => image.url),
    });
  }

  return dropUndefined({
    ...shared,
    operation: 'imageTo3D' as const,
    imageUrl: data.sourceImages[0]?.url ?? '',
  });
}
