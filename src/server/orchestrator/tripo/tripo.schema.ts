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

import type { TripoFalPolyGenInput } from '@civitai/client';
import * as z from 'zod';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';

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

/** Strip undefined fields so we don't send empty keys to the orchestrator. */
function dropUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/**
 * Convert form data to a Tripo/Fal PolyGen input. Used by the graph handler
 * when building the `PolyGenStepTemplate` for `submitWorkflow`.
 */
export function toTripoPolyGenInput(data: TripoGenerationSchema): TripoFalPolyGenInput {
  return dropUndefined({
    engine: 'fal' as const,
    model: 'tripo' as const,
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
