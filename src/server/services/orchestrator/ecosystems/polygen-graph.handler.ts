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

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type PolyGenCtx = EcosystemGraphOutput & { ecosystem: 'PolyGen' };

/**
 * Build a `PolyGenStepTemplate` from a validated polygen-graph snapshot.
 *
 * The snapshot mostly mirrors `Model3DGenerationSchema` already; the one
 * twist is that the graph uses `polygenMode` (avoids clashing with the
 * standard `mode` Controller in GenerationForm.tsx) — we map it back to
 * `mode` here before handing off to the shared input builder.
 */
export const createPolyGenInput = defineHandler<PolyGenCtx, StepInput[]>((data) => {
  const { polygenMode, ...rest } = data as PolyGenCtx & { polygenMode?: 'preview' | 'full' };

  // Synthesize the schema shape `toMeshyPolyGenInput` expects.
  const schemaShape = {
    ...rest,
    ...(polygenMode !== undefined ? { mode: polygenMode } : {}),
  } as unknown as Model3DGenerationSchema;

  const input = toMeshyPolyGenInput(schemaShape) as
    | MeshyTextTo3dFalPolyGenInput
    | MeshyImageTo3dFalPolyGenInput;

  const step: PolyGenStepTemplate = {
    $type: 'polyGen',
    input,
  };

  // Cast to StepInput[] — the shared `StepInput` union doesn't list
  // `PolyGenStepTemplate` (it's the union of the V2 ecosystems' canonical
  // step types), but the orchestrator queue accepts polyGen steps natively.
  return [step as unknown as StepInput];
});
