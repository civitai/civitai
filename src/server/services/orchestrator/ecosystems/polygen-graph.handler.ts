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
import { buildModel3DPreviewStep } from './model3d-preview';

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
export const createPolyGenInput = defineHandler<PolyGenCtx, StepInput[]>((data, ctx) => {
  const { polygenMode, ...rest } = data as PolyGenCtx & { polygenMode?: 'preview' | 'full' };

  // The orchestrator schema discriminates on `process` and speaks `sourceImage`;
  // derive both from `workflow` + `images[0]` (the graph carries neither).
  const process = data.workflow.startsWith('txt') ? 'textTo3D' : 'imageTo3D';
  const sourceImage = process === 'imageTo3D' ? data.images?.[0] : undefined;
  const schemaShape = {
    ...rest,
    process,
    ...(polygenMode !== undefined ? { mode: polygenMode } : {}),
    ...(sourceImage ? { sourceImage } : {}),
  } as unknown as Model3DGenerationSchema;

  const input = toMeshyPolyGenInput(schemaShape) as
    | MeshyTextTo3dFalPolyGenInput
    | MeshyImageTo3dFalPolyGenInput;

  const polyGenStep: PolyGenStepTemplate = {
    $type: 'polyGen',
    input,
  };

  // Chain a `model3DPreview` step that renders a single controllable 2D
  // preview of the generated mesh (see `buildModel3DPreviewStep`).
  const previewStep = buildModel3DPreviewStep(ctx.baseStepIndex);

  // Cast to StepInput[] — the shared `StepInput` union lists neither
  // `PolyGenStepTemplate` nor the (client-untyped) `model3DPreview` step,
  // but the orchestrator queue accepts both natively.
  return [polyGenStep, previewStep] as unknown as StepInput[];
});
