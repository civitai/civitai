/**
 * Trellis.2 Ecosystem Handler (V2 unified pipeline)
 *
 * Converts a validated trellis2-graph snapshot into a `PolyGenStepTemplate` so
 * the unified generate/whatif pipeline can submit it like any other ecosystem
 * step. Mirrors `pixal3d-graph.handler.ts` (the sibling Trellis2 modelVersion);
 * differs only in `modelVersion` (`trellis2`) via `toTrellis2PolyGenInput`.
 *
 * The trellis2 graph carries the standard `images` array (polygen img2model3d
 * convention), which we map to the schema's `sourceImage` before handing off to
 * the converter. All other node names match the schema 1:1.
 */

import type { PolyGenStepTemplate, Trellis2ImageTo3dComfyPolyGenInput } from '@civitai/client';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import {
  toTrellis2PolyGenInput,
  type Trellis2GenerationSchema,
} from '~/server/orchestrator/trellis2/trellis2.schema';
import { buildModel3DPreviewStep } from './model3d-preview';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type Trellis2Ctx = EcosystemGraphOutput & { ecosystem: 'Trellis2' };

export const createTrellis2Input = defineHandler<Trellis2Ctx, StepInput[]>((data, ctx) => {
  const sourceImage = (data as { images?: Array<{ url: string; width: number; height: number }> })
    .images?.[0];
  const input = toTrellis2PolyGenInput({
    ...data,
    ...(sourceImage ? { sourceImage } : {}),
  } as unknown as Trellis2GenerationSchema) as Trellis2ImageTo3dComfyPolyGenInput;

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
