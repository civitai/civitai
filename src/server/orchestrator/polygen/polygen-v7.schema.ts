/**
 * PolyGen v7 Schema (Meshy v7 via Fal)
 *
 * Zod schemas for the Meshy v7 3D-model generation form. v7 drops text-to-3D
 * and adds a multi-view operation, so the two processes are:
 *   - imageTo3D      — one source image -> 3D model
 *   - multiImageTo3D — 2-4 views of the same object -> 3D model
 *
 * `process` is derived from the number of source images rather than being
 * picked by the user: Meshy exposes the two as separate endpoints, but from
 * the form's point of view they are one "image(s) to 3D" control.
 *
 * v7 is selected via the `polygenVersion` control inside the PolyGen
 * ecosystem, not as an ecosystem of its own.
 *
 * The shared Meshy fields (targetPolycount, topology, symmetryMode,
 * shouldRemesh, enablePbr, texturePrompt, enableRigging, enableAnimation)
 * match `MeshyFalPolyGenInput` 1:1 and behave as they do on v6
 * (`polygen.schema.ts`). v7 has no `seed` — the orchestrator type only carries
 * it on the v6 branch.
 */

import type {
  MeshyV7ImageTo3dFalPolyGenInput,
  MeshyV7MultiImageTo3dFalPolyGenInput,
} from '@civitai/client';
import * as z from 'zod';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';
import {
  polygenSymmetryModes,
  polygenTopologies,
} from '~/server/orchestrator/polygen/polygen.schema';

// =============================================================================
// Constants
// =============================================================================

export const polygenV7PoseModes = ['none', 'a-pose', 't-pose'] as const;
export const polygenV7ModelTypes = ['standard', 'lowpoly'] as const;

const MIN_POLYCOUNT = 100;
const MAX_POLYCOUNT = 300_000;
const DEFAULT_POLYCOUNT = 30_000;

const MAX_TEXTURE_PROMPT_LENGTH = 600;

const MIN_IMAGES = 1;
const MAX_IMAGES = 4;

const MIN_RIGGING_HEIGHT = 0.1;
const MAX_RIGGING_HEIGHT = 10;

const MIN_ANIMATION_ACTION_ID = 0;
const MAX_ANIMATION_ACTION_ID = 10_000;

// =============================================================================
// Schema
// =============================================================================

export const polygenV7GenerationSchema = z.object({
  // 1 image -> imageTo3D, 2-4 -> multiImageTo3D. Derived in
  // `toMeshyV7PolyGenInput` so the form never has to expose the split.
  sourceImages: z.array(sourceImageSchema).min(MIN_IMAGES).max(MAX_IMAGES),
  shouldTexture: z.boolean().default(true),
  poseMode: z.enum(polygenV7PoseModes).default('none'),
  // Single-image only — Meshy has no ultra/lowpoly mode on multi-view.
  ultraMode: z.boolean().default(false),
  modelType: z.enum(polygenV7ModelTypes).default('standard'),
  riggingHeightMeters: z.number().min(MIN_RIGGING_HEIGHT).max(MAX_RIGGING_HEIGHT).optional(),
  animationActionId: z
    .number()
    .int()
    .min(MIN_ANIMATION_ACTION_ID)
    .max(MAX_ANIMATION_ACTION_ID)
    .optional(),
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
});
export type PolyGenV7GenerationSchema = z.infer<typeof polygenV7GenerationSchema>;

// =============================================================================
// Helper — convert validated schema to Meshy v7 / Fal PolyGen input shape
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
 * Convert form data to a Meshy v7 / Fal PolyGen input. Used by the graph
 * handler when building the `PolyGenStepTemplate` for `submitWorkflow`.
 */
export function toMeshyV7PolyGenInput(
  data: PolyGenV7GenerationSchema
): MeshyV7ImageTo3dFalPolyGenInput | MeshyV7MultiImageTo3dFalPolyGenInput {
  // Same rigging/animation coupling as v6: animation targets the rigged
  // mesh's skeleton, so the API rejects animation without rigging. The form
  // exposes one "Animate" toggle and rigging follows it.
  const enableAnimation = !!data.enableAnimation;
  const enableRigging = enableAnimation || !!data.enableRigging;

  const shared = dropUndefined({
    engine: 'fal' as const,
    model: 'meshy' as const,
    version: 'v7' as const,
    targetPolycount: data.targetPolycount,
    topology: data.topology,
    symmetryMode: data.symmetryMode,
    shouldRemesh: data.shouldRemesh,
    enablePbr: data.enablePbr,
    texturePrompt: data.texturePrompt,
    enableRigging,
    enableAnimation,
    shouldTexture: data.shouldTexture,
    poseMode: data.poseMode,
    riggingHeightMeters: enableRigging ? data.riggingHeightMeters : undefined,
    animationActionId: enableAnimation ? data.animationActionId : undefined,
  });

  if (data.sourceImages.length > 1) {
    return dropUndefined({
      ...shared,
      operation: 'multiImageTo3D' as const,
      imageUrls: data.sourceImages.map((image) => image.url),
    }) as MeshyV7MultiImageTo3dFalPolyGenInput;
  }

  return dropUndefined({
    ...shared,
    operation: 'imageTo3D' as const,
    imageUrl: data.sourceImages[0].url,
    ultraMode: data.ultraMode,
    modelType: data.modelType,
  }) as MeshyV7ImageTo3dFalPolyGenInput;
}

export {
  MIN_IMAGES as POLYGEN_V7_MIN_IMAGES,
  MAX_IMAGES as POLYGEN_V7_MAX_IMAGES,
  MIN_RIGGING_HEIGHT as POLYGEN_V7_MIN_RIGGING_HEIGHT,
  MAX_RIGGING_HEIGHT as POLYGEN_V7_MAX_RIGGING_HEIGHT,
  MIN_ANIMATION_ACTION_ID as POLYGEN_V7_MIN_ANIMATION_ACTION_ID,
  MAX_ANIMATION_ACTION_ID as POLYGEN_V7_MAX_ANIMATION_ACTION_ID,
};
