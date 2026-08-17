/**
 * PolyGen Ecosystem Handler (V2 unified pipeline)
 *
 * Converts a validated polygen-graph snapshot into a `PolyGenStepTemplate`
 * so the unified generate/whatif pipeline (`generateFromGraph` /
 * `whatIfFromGraph`) can submit it like any other ecosystem step.
 *
 * The graph carries BOTH Meshy versions (see `polygen-graph.ts`), so this
 * branches on `polygenVersion` and hands off to the matching input builder:
 *   v6 → `toMeshyPolyGenInput`   (textTo3D | imageTo3D)
 *   v7 → `toMeshyV7PolyGenInput` (imageTo3D | multiImageTo3D, by image count)
 *
 * The legacy file (`polyGen.handler.ts`) is kept for `handlePolyGenWorkflowResult`
 * (orchestrator webhook → Draft Model3D row). Only the submit-from-form path
 * routes through this V2 handler.
 */

import type {
  MeshyImageTo3dFalPolyGenInput,
  MeshyTextTo3dFalPolyGenInput,
  MeshyV7ImageTo3dFalPolyGenInput,
  MeshyV7MultiImageTo3dFalPolyGenInput,
  PolyGenStepTemplate,
} from '@civitai/client';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import {
  toMeshyPolyGenInput,
  type Model3DGenerationSchema,
} from '~/server/orchestrator/polygen/polygen.schema';
import {
  toMeshyV7PolyGenInput,
  type PolyGenV7GenerationSchema,
} from '~/server/orchestrator/polygen/polygen-v7.schema';
import { buildModel3DPreviewStep } from './model3d-preview';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type PolyGenCtx = EcosystemGraphOutput & { ecosystem: 'PolyGen' };

type SourceImage = { url: string; width: number; height: number };

/**
 * Build a `PolyGenStepTemplate` from a validated polygen-graph snapshot.
 *
 * The snapshot mostly mirrors the orchestrator schemas already; the twists are
 * that the graph uses `polygenMode` (avoids clashing with the standard `mode`
 * Controller in GenerationForm.tsx) and carries `images` where the schemas want
 * `sourceImage` (v6) / `sourceImages` (v7).
 */
export const createPolyGenInput = defineHandler<PolyGenCtx, StepInput[]>((data, ctx) => {
  const { polygenMode, ...rest } = data as PolyGenCtx & {
    polygenMode?: 'preview' | 'full';
    polygenVersion?: 'v6' | 'v7';
  };
  const images = (data as { images?: SourceImage[] }).images ?? [];

  let input:
    | MeshyTextTo3dFalPolyGenInput
    | MeshyImageTo3dFalPolyGenInput
    | MeshyV7ImageTo3dFalPolyGenInput
    | MeshyV7MultiImageTo3dFalPolyGenInput;

  if ((data as { polygenVersion?: string }).polygenVersion === 'v7') {
    // v7 is image-driven only; the operation follows the image count.
    input = toMeshyV7PolyGenInput({
      ...rest,
      sourceImages: images,
    } as unknown as PolyGenV7GenerationSchema);
  } else {
    // The v6 schema discriminates on `process` and speaks `sourceImage`; derive
    // both from `workflow` + `images[0]` (the graph carries neither).
    const process = data.workflow.startsWith('txt') ? 'textTo3D' : 'imageTo3D';
    const sourceImage = process === 'imageTo3D' ? images[0] : undefined;
    input = toMeshyPolyGenInput({
      ...rest,
      process,
      ...(polygenMode !== undefined ? { mode: polygenMode } : {}),
      ...(sourceImage ? { sourceImage } : {}),
    } as unknown as Model3DGenerationSchema);
  }

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
