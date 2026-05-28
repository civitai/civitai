/**
 * PolyGen Schema (Meshy via Fal)
 *
 * Zod schemas for the 3D model generation form. Two processes:
 *   - textTo3D — prompt -> 3D model
 *   - imageTo3D — source image -> 3D model
 *
 * Mirrors the shape of `src/server/orchestrator/sora/sora.schema.ts`:
 * - `sourceImageSchema` reused for the "URL or upload" pattern in image-to-3D.
 * - Discriminated union on `process` so the form / submitter knows which
 *   Meshy operation to call (`MeshyTextTo3dFalPolyGenInput` vs
 *   `MeshyImageTo3dFalPolyGenInput`).
 *
 * The Meshy "shared" fields (targetPolycount, topology, symmetryMode,
 * shouldRemesh, enablePbr, texturePrompt, enableRigging, enableAnimation,
 * seed) appear on both processes and match `MeshyFalPolyGenInput` 1:1.
 */

import type {
  MeshyImageTo3dFalPolyGenInput,
  MeshyTextTo3dFalPolyGenInput,
} from '@civitai/client';
import * as z from 'zod';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';

// =============================================================================
// Constants
// =============================================================================

export const polygenTopologies = ['quad', 'triangle'] as const;
export const polygenSymmetryModes = ['off', 'auto', 'on'] as const;
export const polygenTextModes = ['preview', 'full'] as const;
export const polygenProcesses = ['textTo3D', 'imageTo3D'] as const;

const MIN_POLYCOUNT = 100;
const MAX_POLYCOUNT = 300_000;
const DEFAULT_POLYCOUNT = 30_000;

const MAX_PROMPT_LENGTH = 600;
const MAX_TEXTURE_PROMPT_LENGTH = 600;

// =============================================================================
// Shared Meshy fields (applied to both text-to-3D and image-to-3D)
// =============================================================================

const meshyShared = {
  targetPolycount: z
    .number()
    .int()
    .min(MIN_POLYCOUNT)
    .max(MAX_POLYCOUNT)
    .default(DEFAULT_POLYCOUNT),
  topology: z.enum(polygenTopologies).default('triangle'),
  symmetryMode: z.enum(polygenSymmetryModes).default('auto'),
  shouldRemesh: z.boolean().default(true),
  enablePbr: z.boolean().default(false),
  texturePrompt: z.string().max(MAX_TEXTURE_PROMPT_LENGTH).optional(),
  enableRigging: z.boolean().default(false),
  enableAnimation: z.boolean().default(false),
  // Meshy accepts a 32-bit signed int seed; we keep it optional so the
  // workflow handler can randomize when omitted.
  seed: z.number().int().min(-2147483648).max(2147483647).optional(),
};

// =============================================================================
// Text-to-3D
// =============================================================================

export const textTo3DSchema = z.object({
  process: z.literal('textTo3D'),
  prompt: z
    .string()
    .min(1, 'Prompt is required')
    .max(MAX_PROMPT_LENGTH, `Prompt cannot be longer than ${MAX_PROMPT_LENGTH} characters`),
  mode: z.enum(polygenTextModes).default('full'),
  enablePromptExpansion: z.boolean().default(false),
  ...meshyShared,
});
export type TextTo3DSchema = z.infer<typeof textTo3DSchema>;

// =============================================================================
// Image-to-3D
// =============================================================================

export const imageTo3DSchema = z.object({
  process: z.literal('imageTo3D'),
  // Reuse sora's sourceImageSchema — same "URL or upload" handling.
  sourceImage: sourceImageSchema,
  shouldTexture: z.boolean().default(true),
  ...meshyShared,
});
export type ImageTo3DSchema = z.infer<typeof imageTo3DSchema>;

// =============================================================================
// Discriminated union
// =============================================================================

export const model3dGenerationSchema = z.discriminatedUnion('process', [
  textTo3DSchema,
  imageTo3DSchema,
]);
export type Model3DGenerationSchema = z.infer<typeof model3dGenerationSchema>;

// =============================================================================
// Helpers — convert validated schema to Meshy/Fal PolyGen input shape
// =============================================================================

/**
 * Strip undefined fields from an object. Mirrors the orchestrator's
 * `removeEmpty` helper but inline here to keep the schema self-contained.
 */
function dropUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/**
 * Convert form data to a Meshy/Fal PolyGen input. Used by the handler
 * when building the `PolyGenStep` for `submitWorkflow`.
 */
export function toMeshyPolyGenInput(
  data: Model3DGenerationSchema
): MeshyTextTo3dFalPolyGenInput | MeshyImageTo3dFalPolyGenInput {
  const shared = dropUndefined({
    targetPolycount: data.targetPolycount,
    topology: data.topology,
    symmetryMode: data.symmetryMode,
    shouldRemesh: data.shouldRemesh,
    enablePbr: data.enablePbr,
    texturePrompt: data.texturePrompt,
    enableRigging: data.enableRigging,
    enableAnimation: data.enableAnimation,
    seed: data.seed,
  });

  if (data.process === 'textTo3D') {
    return dropUndefined({
      ...shared,
      engine: 'fal' as const,
      model: 'meshy' as const,
      operation: 'textTo3D' as const,
      prompt: data.prompt,
      mode: data.mode,
      enablePromptExpansion: data.enablePromptExpansion,
    }) as MeshyTextTo3dFalPolyGenInput;
  }

  return dropUndefined({
    ...shared,
    engine: 'fal' as const,
    model: 'meshy' as const,
    operation: 'imageTo3D' as const,
    imageUrl: data.sourceImage.url,
    shouldTexture: data.shouldTexture,
  }) as MeshyImageTo3dFalPolyGenInput;
}

// =============================================================================
// Registry entry — consumed by generation.config.ts
// =============================================================================

/**
 * PolyGen generation config. Shaped loosely after the video-gen configs
 * (label / whatIfProps / metadataDisplayProps / schema / processes) but
 * deliberately kept as a plain object: the existing `VideoGenerationConfig2`
 * helper is video-shaped (txt2vid/img2vid) and PolyGen output is 3D, not
 * video. We expose the same surface the UI form / whatif callers need.
 */
export const polyGenGenerationConfig = {
  label: 'PolyGen (Meshy)',
  description: 'Generate 3D models from text or images via Meshy.',
  engine: 'polyGen' as const,
  processes: polygenProcesses,
  whatIfProps: [
    'process',
    'mode',
    'targetPolycount',
    'topology',
    'enablePbr',
    'enableRigging',
    'enableAnimation',
    'shouldTexture',
  ] as const,
  metadataDisplayProps: [
    'process',
    'prompt',
    'mode',
    'targetPolycount',
    'topology',
    'symmetryMode',
    'enablePbr',
    'enableRigging',
    'enableAnimation',
    'shouldTexture',
    'seed',
  ] as const,
  schema: model3dGenerationSchema,
  toMeshyPolyGenInput,
};

export type PolyGenGenerationConfig = typeof polyGenGenerationConfig;
