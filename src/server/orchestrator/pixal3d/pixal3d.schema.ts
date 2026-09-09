/**
 * Pixal3D Schema (Pixal3D via Comfy / Trellis2)
 *
 * Zod schema for the Pixal3D 3D-model generation form. Pixal3D is a
 * `modelVersion` of the Trellis2 comfy pipeline, exposed as its own ecosystem.
 * Like Tripo and Hunyuan3D it is image-to-3D only, so there is no text-to-3D
 * branch and no `process` discriminator.
 *
 * Mirrors `src/server/orchestrator/hunyuan3d/hunyuan3d.schema.ts` (the other
 * comfy 3D ecosystem):
 * - `sourceImageSchema` reused for the "URL or upload" pattern.
 * - `toPixal3dPolyGenInput` converts validated form data to the
 *   `Trellis2ImageTo3dComfyPolyGenInput` shape (`engine: 'comfy',
 *   model: 'trellis2', operation: 'imageTo3D', modelVersion: 'pixal3D'`)
 *   consumed by the graph handler when building the `polyGen` step.
 *
 * Only a small, user-meaningful subset of the client's comfy knobs is surfaced
 * (texture / remesh / pbr toggles + seed); the orchestrator applies its own
 * defaults for the remaining sampler / step / resolution fields.
 */

import type { Trellis2ImageTo3dComfyPolyGenInput } from '@civitai/client';
import * as z from 'zod';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';
import { removeEmpty } from '~/utils/object-helpers';

// =============================================================================
// Schema
// =============================================================================

export const pixal3dGenerationSchema = z.object({
  sourceImage: sourceImageSchema,
  shouldTexture: z.boolean().default(true),
  shouldRemesh: z.boolean().default(true),
  enablePbr: z.boolean().default(false),
  // Comfy accepts a 32-bit signed int seed; optional so the handler can
  // randomize when omitted.
  seed: z.number().int().min(-2147483648).max(2147483647).optional(),
});
export type Pixal3dGenerationSchema = z.infer<typeof pixal3dGenerationSchema>;

// =============================================================================
// Helper — convert validated schema to Pixal3D/Comfy PolyGen input shape
// =============================================================================

/**
 * Convert form data to a Pixal3D/Comfy PolyGen input. Used by the graph handler
 * when building the `PolyGenStepTemplate` for `submitWorkflow`. `removeEmpty`
 * strips only null/undefined (not `false`/`0`), so the boolean toggles and a
 * `seed: 0` survive while an omitted `seed` is dropped.
 */
export function toPixal3dPolyGenInput(
  data: Pixal3dGenerationSchema
): Trellis2ImageTo3dComfyPolyGenInput {
  return removeEmpty({
    engine: 'comfy' as const,
    model: 'trellis2' as const,
    operation: 'imageTo3D' as const,
    modelVersion: 'pixal3D' as const,
    imageUrl: data.sourceImage.url,
    shouldTexture: data.shouldTexture,
    shouldRemesh: data.shouldRemesh,
    enablePbr: data.enablePbr,
    seed: data.seed,
  }) as Trellis2ImageTo3dComfyPolyGenInput;
}
