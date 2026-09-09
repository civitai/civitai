/**
 * Pixal3D Ecosystem Handler (V2 unified pipeline)
 *
 * Converts a validated pixal3d-graph snapshot into a `PolyGenStepTemplate` so
 * the unified generate/whatif pipeline can submit it like any other ecosystem
 * step. Mirrors `hunyuan3d-graph.handler.ts` (the other comfy 3D ecosystem);
 * differs in the model/modelVersion (`trellis2` / `pixal3D`) and the input
 * builder (`toPixal3dPolyGenInput`).
 *
 * The pixal3d graph carries the standard `images` array (polygen img2model3d
 * convention), which we map to the schema's `sourceImage` before handing off to
 * the converter. All other node names match the schema 1:1.
 */

import type { PolyGenStepTemplate, Trellis2ImageTo3dComfyPolyGenInput } from '@civitai/client';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import {
  toPixal3dPolyGenInput,
  type Pixal3dGenerationSchema,
} from '~/server/orchestrator/pixal3d/pixal3d.schema';
import { buildModel3DPreviewStep } from './model3d-preview';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type Pixal3dCtx = EcosystemGraphOutput & { ecosystem: 'Pixal3D' };

export const createPixal3dInput = defineHandler<Pixal3dCtx, StepInput[]>((data, ctx) => {
  const sourceImage = (data as { images?: Array<{ url: string; width: number; height: number }> })
    .images?.[0];
  const input = toPixal3dPolyGenInput({
    ...data,
    ...(sourceImage ? { sourceImage } : {}),
  } as unknown as Pixal3dGenerationSchema) as Trellis2ImageTo3dComfyPolyGenInput;

  const polyGenStep: PolyGenStepTemplate = {
    $type: 'polyGen',
    input,
  };

  const previewStep = buildModel3DPreviewStep(ctx.baseStepIndex);

  // Cast to StepInput[] — the shared `StepInput` union lists neither
  // `PolyGenStepTemplate` nor the (client-untyped) `model3DPreview` step,
  // but the orchestrator queue accepts both natively.
  return [polyGenStep, previewStep] as unknown as StepInput[];
});
