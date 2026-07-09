/**
 * PolyGen Ecosystem Handler (V2 unified pipeline)
 *
 * Converts a validated polygen-graph snapshot into a `PolyGenStepTemplate`
 * so the unified generate/whatif pipeline (`generateFromGraph` /
 * `whatIfFromGraph`) can submit it like any other ecosystem step.
 *
 * Why a thin wrapper: the existing `polyGen.handler.ts` (legacy bespoke path)
 * already builds the Meshy/Fal input shape from the RHF form schema. The
 * graph snapshot has the same shape by the time it reaches us — both come
 * from `model3dGenerationSchema` originally — so we just feed it into
 * `toMeshyPolyGenInput` and wrap the result in a `polyGen` step.
 *
 * The legacy file (`polyGen.handler.ts`) is kept for `handlePolyGenWorkflowResult`
 * (orchestrator webhook → Draft Model3D row). Only the submit-from-form path
 * routes through this V2 handler.
 */

import type {
  MeshyImageTo3dFalPolyGenInput,
  MeshyTextTo3dFalPolyGenInput,
  PolyGenStepTemplate,
} from '@civitai/client';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import {
  toMeshyPolyGenInput,
  type Model3DGenerationSchema,
} from '~/server/orchestrator/polygen/polygen.schema';
import { buildStepRef } from '../step-ref';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type PolyGenCtx = EcosystemGraphOutput & { ecosystem: 'PolyGen' };

/** Square dimensions of the generated 2D preview (matches the queue card aspect). */
const MODEL_3D_PREVIEW_SIZE = 1024;

/**
 * Single hero camera for the 2D preview render. The PolyGen output already
 * carries a `thumbnail`, but its angle isn't controllable — this straight-on
 * front pose (no yaw, slight downward tilt) keeps the mesh centered and
 * upright rather than the skewed 3/4 view. Tweak here to re-frame every 3D
 * preview. `distance`/`fov` come from the orchestrator's reference poses.
 */
const MODEL_3D_PREVIEW_CAMERA_POSE = {
  name: 'front',
  yaw: 0,
  pitch: 8,
  distance: 2.8,
  fov: 45,
} as const;

/**
 * Build a `PolyGenStepTemplate` from a validated polygen-graph snapshot.
 *
 * The snapshot mostly mirrors `Model3DGenerationSchema` already; the one
 * twist is that the graph uses `polygenMode` (avoids clashing with the
 * standard `mode` Controller in GenerationForm.tsx) — we map it back to
 * `mode` here before handing off to the shared input builder.
 */
export const createPolyGenInput = defineHandler<PolyGenCtx, StepInput[]>((data, ctx) => {
  const { polygenMode, ...rest } = data as PolyGenCtx & { polygenMode?: 'preview' | 'full' };

  // Synthesize the schema shape `toMeshyPolyGenInput` expects.
  const schemaShape = {
    ...rest,
    ...(polygenMode !== undefined ? { mode: polygenMode } : {}),
  } as unknown as Model3DGenerationSchema;

  const input = toMeshyPolyGenInput(schemaShape) as
    | MeshyTextTo3dFalPolyGenInput
    | MeshyImageTo3dFalPolyGenInput;

  const polyGenStep: PolyGenStepTemplate = {
    $type: 'polyGen',
    input,
  };

  // Chain a `model3DPreview` step that renders a single controllable 2D
  // preview of the generated mesh (see MODEL_3D_PREVIEW_CAMERA_POSE). It
  // references the polyGen step's GLB via `$ref` — the orchestrator resolves
  // `$<baseStepIndex>` positionally at runtime. `suppressOutput` keeps its
  // image out of the generic output grid/counters; the queue card's 3D
  // renderer reads it directly as the thumbnail.
  const previewStep = {
    $type: 'model3DPreview',
    input: {
      model: buildStepRef(ctx.baseStepIndex, 'output.model.url') as unknown as string,
      format: 'glb',
      width: MODEL_3D_PREVIEW_SIZE,
      height: MODEL_3D_PREVIEW_SIZE,
      outputFormat: 'png',
      cameraPoses: [MODEL_3D_PREVIEW_CAMERA_POSE],
    },
    metadata: { suppressOutput: true },
  };

  // Cast to StepInput[] — the shared `StepInput` union lists neither
  // `PolyGenStepTemplate` nor the (client-untyped) `model3DPreview` step,
  // but the orchestrator queue accepts both natively.
  return [polyGenStep, previewStep] as unknown as StepInput[];
});
