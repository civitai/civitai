/**
 * Hunyuan3D Schema (Hunyuan3D via Comfy)
 *
 * Zod schema for the Hunyuan3D 3D-model generation form. Hunyuan3D runs on the
 * `comfy` engine (unlike Meshy/Tripo, which are `fal`) and exposes image-to-3D
 * as its primary operation, so — like Tripo — there is no text-to-3D branch.
 *
 * Mirrors `src/server/orchestrator/polygen/polygen.schema.ts`:
 * - `sourceImageSchema` reused for the "URL or upload" pattern.
 * - `toHunyuan3dPolyGenInput` converts validated form data to the
 *   `Hunyuan3dImageTo3dComfyPolyGenInput` shape (`engine: 'comfy',
 *   model: 'hunyuan3D', operation: 'imageTo3D'`) consumed by the graph handler.
 *
 * We surface a user-meaningful subset of the client's Comfy knobs
 * (modelVersion, steps, cfgScale, octreeResolution, texture/remesh/pbr toggles)
 * and let the orchestrator apply its own defaults for the remaining sampler /
 * scheduler / resolution / shift fields.
 */

import type { Hunyuan3dImageTo3dComfyPolyGenInput } from '@civitai/client';
import * as z from 'zod';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';

// =============================================================================
// Constants
// =============================================================================

export const hunyuan3dModelVersions = ['v2', 'v2.1', 'v2-mini'] as const;

const MIN_STEPS = 1;
const MAX_STEPS = 100;
const DEFAULT_STEPS = 30;

const MIN_CFG_SCALE = 0;
const MAX_CFG_SCALE = 20;
const DEFAULT_CFG_SCALE = 5;

const MIN_OCTREE_RESOLUTION = 64;
const MAX_OCTREE_RESOLUTION = 512;
const DEFAULT_OCTREE_RESOLUTION = 256;

const MAX_PROMPT_LENGTH = 600;

// =============================================================================
// Schema
// =============================================================================

export const hunyuan3dGenerationSchema = z.object({
  sourceImage: sourceImageSchema,
  // Optional texture/style hint. Hunyuan3D drives geometry from the image;
  // the prompt only nudges texturing, so it stays optional.
  prompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
  modelVersion: z.enum(hunyuan3dModelVersions).default('v2.1'),
  shouldTexture: z.boolean().default(true),
  shouldRemesh: z.boolean().default(true),
  enablePbr: z.boolean().default(false),
  steps: z.number().int().min(MIN_STEPS).max(MAX_STEPS).default(DEFAULT_STEPS),
  cfgScale: z.number().min(MIN_CFG_SCALE).max(MAX_CFG_SCALE).default(DEFAULT_CFG_SCALE),
  octreeResolution: z
    .number()
    .int()
    .min(MIN_OCTREE_RESOLUTION)
    .max(MAX_OCTREE_RESOLUTION)
    .default(DEFAULT_OCTREE_RESOLUTION),
  // Comfy accepts a 32-bit signed int seed; optional so the handler can
  // randomize when omitted.
  seed: z.number().int().min(-2147483648).max(2147483647).optional(),
});
export type Hunyuan3dGenerationSchema = z.infer<typeof hunyuan3dGenerationSchema>;

// =============================================================================
// Helper — convert validated schema to Hunyuan3D/Comfy PolyGen input shape
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
 * Convert form data to a Hunyuan3D/Comfy PolyGen input. Used by the graph
 * handler when building the `PolyGenStepTemplate` for `submitWorkflow`.
 */
export function toHunyuan3dPolyGenInput(
  data: Hunyuan3dGenerationSchema
): Hunyuan3dImageTo3dComfyPolyGenInput {
  return dropUndefined({
    engine: 'comfy' as const,
    model: 'hunyuan3D' as const,
    operation: 'imageTo3D' as const,
    imageUrl: data.sourceImage.url,
    prompt: data.prompt,
    modelVersion: data.modelVersion,
    shouldTexture: data.shouldTexture,
    shouldRemesh: data.shouldRemesh,
    enablePbr: data.enablePbr,
    steps: data.steps,
    cfgScale: data.cfgScale,
    octreeResolution: data.octreeResolution,
    seed: data.seed,
  }) as Hunyuan3dImageTo3dComfyPolyGenInput;
}
