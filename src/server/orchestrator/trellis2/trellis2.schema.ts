/**
 * Trellis.2 Schema (Trellis.2 via Comfy)
 *
 * Zod schema for the Trellis.2 3D-model generation form. Trellis.2 is the
 * base `modelVersion` of the same comfy pipeline Pixal3D rides
 * (`Trellis2ImageTo3dComfyPolyGenInput`), differing only in
 * `modelVersion: 'trellis2'` vs Pixal3D's `'pixal3D'`. Like Pixal3D / Tripo /
 * Hunyuan3D it is image-to-3D only, so there is no text-to-3D branch and no
 * `process` discriminator.
 *
 * Mirrors `src/server/orchestrator/pixal3d/pixal3d.schema.ts`:
 * - `sourceImageSchema` reused for the "URL or upload" pattern.
 * - `toTrellis2PolyGenInput` converts validated form data to the
 *   `Trellis2ImageTo3dComfyPolyGenInput` shape (`engine: 'comfy',
 *   model: 'trellis2', operation: 'imageTo3D', modelVersion: 'trellis2'`)
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

export const trellis2GenerationSchema = z.object({
  sourceImage: sourceImageSchema,
  shouldTexture: z.boolean().default(true),
  shouldRemesh: z.boolean().default(true),
  enablePbr: z.boolean().default(false),
  // Comfy accepts a 32-bit signed int seed; optional so the handler can
  // randomize when omitted.
  seed: z.number().int().min(-2147483648).max(2147483647).optional(),
});
export type Trellis2GenerationSchema = z.infer<typeof trellis2GenerationSchema>;

// =============================================================================
// Helper — convert validated schema to Trellis.2/Comfy PolyGen input shape
// =============================================================================

/**
 * Convert form data to a Trellis.2/Comfy PolyGen input. Used by the graph
 * handler when building the `PolyGenStepTemplate` for `submitWorkflow`.
 * `removeEmpty` strips only null/undefined (not `false`/`0`), so the boolean
 * toggles and a `seed: 0` survive while an omitted `seed` is dropped.
 */
export function toTrellis2PolyGenInput(
  data: Trellis2GenerationSchema
): Trellis2ImageTo3dComfyPolyGenInput {
  return removeEmpty({
    engine: 'comfy' as const,
    model: 'trellis2' as const,
    operation: 'imageTo3D' as const,
    modelVersion: 'trellis2' as const,
    imageUrl: data.sourceImage.url,
    shouldTexture: data.shouldTexture,
    shouldRemesh: data.shouldRemesh,
    enablePbr: data.enablePbr,
    seed: data.seed,
  }) as Trellis2ImageTo3dComfyPolyGenInput;
}
