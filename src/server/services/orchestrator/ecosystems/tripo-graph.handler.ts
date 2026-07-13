/**
 * Tripo Ecosystem Handler (V2 unified pipeline)
 *
 * Converts a validated tripo-graph snapshot into a `PolyGenStepTemplate` so the
 * unified generate/whatif pipeline (`generateFromGraph` / `whatIfFromGraph`)
 * can submit it like any other ecosystem step. Mirrors
 * `polygen-graph.handler.ts`; the only differences are the model/engine
 * (`tripo`/`fal`) and the input builder (`toTripoPolyGenInput`).
 *
 * Tripo graph field names match the schema 1:1 except the image source: the
 * graph carries the standard `images` array (polygen img2model3d convention),
 * which we map to the schema's `sourceImage` before handing off to the converter.
 */

import type { PolyGenStepTemplate, TripoFalPolyGenInput } from '@civitai/client';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import {
  toTripoPolyGenInput,
  type TripoGenerationSchema,
} from '~/server/orchestrator/tripo/tripo.schema';
import { buildModel3DPreviewStep } from './model3d-preview';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type TripoCtx = EcosystemGraphOutput & { ecosystem: 'Tripo' };

export const createTripoInput = defineHandler<TripoCtx, StepInput[]>((data, ctx) => {
  const sourceImage = (data as { images?: Array<{ url: string; width: number; height: number }> })
    .images?.[0];
  const input = toTripoPolyGenInput({
    ...data,
    ...(sourceImage ? { sourceImage } : {}),
  } as unknown as TripoGenerationSchema) as TripoFalPolyGenInput;

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
