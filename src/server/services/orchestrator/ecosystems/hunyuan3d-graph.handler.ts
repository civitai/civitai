/**
 * Hunyuan3D Ecosystem Handler (V2 unified pipeline)
 *
 * Converts a validated hunyuan3d-graph snapshot into a `PolyGenStepTemplate` so
 * the unified generate/whatif pipeline can submit it like any other ecosystem
 * step. Mirrors `polygen-graph.handler.ts`; differs in the model/engine
 * (`hunyuan3D`/`comfy`) and the input builder (`toHunyuan3dPolyGenInput`).
 *
 * The hunyuan3d graph prefixes the fields whose bare names collide with the
 * standard image Controllers (`hunyuanPrompt`, `hunyuanModelVersion`,
 * `hunyuanSteps`, `hunyuanCfgScale`, `hunyuanOctreeResolution`); this handler
 * maps them back to the schema field names before building the input.
 */

import type { Hunyuan3dImageTo3dComfyPolyGenInput, PolyGenStepTemplate } from '@civitai/client';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import {
  toHunyuan3dPolyGenInput,
  type Hunyuan3dGenerationSchema,
} from '~/server/orchestrator/hunyuan3d/hunyuan3d.schema';
import { buildModel3DPreviewStep } from './model3d-preview';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type Hunyuan3dCtx = EcosystemGraphOutput & { ecosystem: 'Hunyuan3D' };

type Hunyuan3dGraphData = {
  // The graph carries the standard `images` array (polygen img2model3d
  // convention); mapped to the schema's `sourceImage` below.
  images?: Array<{ url: string; width: number; height: number }>;
  hunyuanPrompt?: string;
  hunyuanModelVersion: 'v2' | 'v2.1' | 'v2-mini';
  shouldTexture: boolean;
  shouldRemesh: boolean;
  enablePbr: boolean;
  hunyuanSteps: number;
  hunyuanCfgScale: number;
  hunyuanOctreeResolution: number;
  seed?: number;
};

export const createHunyuan3dInput = defineHandler<Hunyuan3dCtx, StepInput[]>((data, ctx) => {
  const {
    images,
    hunyuanPrompt,
    hunyuanModelVersion,
    hunyuanSteps,
    hunyuanCfgScale,
    hunyuanOctreeResolution,
    ...rest
  } = data as unknown as Hunyuan3dGraphData;

  const schemaShape = {
    ...rest,
    ...(images?.[0] ? { sourceImage: images[0] } : {}),
    // Empty prompt ⇒ omit (Hunyuan3D treats the prompt as an optional hint).
    prompt: hunyuanPrompt ? hunyuanPrompt : undefined,
    modelVersion: hunyuanModelVersion,
    steps: hunyuanSteps,
    cfgScale: hunyuanCfgScale,
    octreeResolution: hunyuanOctreeResolution,
  } as unknown as Hunyuan3dGenerationSchema;

  const input = toHunyuan3dPolyGenInput(schemaShape) as Hunyuan3dImageTo3dComfyPolyGenInput;

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
