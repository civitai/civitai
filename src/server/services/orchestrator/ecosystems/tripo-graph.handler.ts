/**
 * Tripo Ecosystem Handler (V2 unified pipeline)
 *
 * Converts a validated tripo-graph snapshot into a `PolyGenStepTemplate` so the
 * unified generate/whatif pipeline (`generateFromGraph` / `whatIfFromGraph`)
 * can submit it like any other ecosystem step. Mirrors
 * `polygen-graph.handler.ts`; the only differences are the model/engine
 * (`tripo`/`fal`) and the input builder (`toTripoPolyGenInput`).
 *
 * Tripo graph node names match the schema field names 1:1, so the snapshot is
 * fed straight into the converter with no remapping.
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
  const input = toTripoPolyGenInput(
    data as unknown as TripoGenerationSchema
  ) as TripoFalPolyGenInput;

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
