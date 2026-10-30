/**
 * The 3D families' handlers for the form-graph lane. Each converts parsed
 * data into a `PolyGenStepTemplate` via the shared schema builders, then
 * chains the `model3DPreview` step. PolyGen branches on `polygenVersion`
 * (v6 text/image, v7 image/multi-image, v7.1 all three) and Tripo on
 * `tripoVersion` (v2.5 image, H3.1 image/multiview); Hunyuan3D maps its
 * `hunyuan*`-prefixed fields back to schema names; the trellis-pipeline pair
 * (Pixal3D / Trellis.2) and Tripo v2.5 map `images[0]` → `sourceImage`.
 */

import type {
  Hunyuan3dImageTo3dComfyPolyGenInput,
  MeshyImageTo3dFalPolyGenInput,
  MeshyTextTo3dFalPolyGenInput,
  MeshyV7ImageTo3dFalPolyGenInput,
  MeshyV7MultiImageTo3dFalPolyGenInput,
  PolyGenStepTemplate,
  Trellis2ImageTo3dComfyPolyGenInput,
  TripoFalPolyGenInput,
} from '@civitai/orchestration-client';
import {
  toMeshyPolyGenInput,
  type Model3DGenerationSchema,
} from '~/server/orchestrator/polygen/polygen.schema';
import {
  toMeshyV7PolyGenInput,
  type PolyGenV7GenerationSchema,
} from '~/server/orchestrator/polygen/polygen-v7.schema';
import {
  toMeshyV71PolyGenInput,
  type MeshyV71PolyGenInput,
  type PolyGenV71GenerationData,
} from '~/server/orchestrator/polygen/polygen-v71.schema';
import {
  toTripoH31PolyGenInput,
  toTripoPolyGenInput,
  type TripoGenerationSchema,
  type TripoH31GenerationData,
} from '~/server/orchestrator/tripo/tripo.schema';
import {
  toHunyuan3dPolyGenInput,
  type Hunyuan3dGenerationSchema,
} from '~/server/orchestrator/hunyuan3d/hunyuan3d.schema';
import {
  toPixal3dPolyGenInput,
  type Pixal3dGenerationSchema,
} from '~/server/orchestrator/pixal3d/pixal3d.schema';
import {
  toTrellis2PolyGenInput,
  type Trellis2GenerationSchema,
} from '~/server/orchestrator/trellis2/trellis2.schema';
import { defineHandler } from '../handlers/handler-factory';
import { buildModel3DPreviewStep } from '../handlers/model3d-preview';
import type { StepInput } from '../handlers';
import type { EcosystemData } from './types';

// The shared `StepInput` union lists neither `PolyGenStepTemplate` nor the
// (client-untyped) `model3DPreview` step, but the orchestrator queue accepts
// both natively.
const withPreview = (step: PolyGenStepTemplate, baseStepIndex: number): StepInput[] =>
  [step, buildModel3DPreviewStep(baseStepIndex)] as unknown as StepInput[];

export const createPolyGenInput = defineHandler<EcosystemData<'PolyGen'>, StepInput[]>(
  (data, ctx) => {
    const { polygenMode, ...rest } = data;
    const images = data.images ?? [];
    const process = data.workflow?.startsWith('txt') ? 'textTo3D' : 'imageTo3D';

    let input:
      | MeshyTextTo3dFalPolyGenInput
      | MeshyImageTo3dFalPolyGenInput
      | MeshyV7ImageTo3dFalPolyGenInput
      | MeshyV7MultiImageTo3dFalPolyGenInput
      | MeshyV71PolyGenInput;

    if (data.polygenVersion === 'v7.1') {
      input = toMeshyV71PolyGenInput({
        ...rest,
        process,
        ...(polygenMode !== undefined ? { mode: polygenMode } : {}),
        sourceImages: process === 'imageTo3D' ? images : [],
      } as unknown as PolyGenV71GenerationData);
    } else if (data.polygenVersion === 'v7') {
      input = toMeshyV7PolyGenInput({
        ...rest,
        sourceImages: images,
      } as unknown as PolyGenV7GenerationSchema);
    } else {
      const sourceImage = process === 'imageTo3D' ? images[0] : undefined;
      input = toMeshyPolyGenInput({
        ...rest,
        process,
        ...(polygenMode !== undefined ? { mode: polygenMode } : {}),
        ...(sourceImage ? { sourceImage } : {}),
      } as unknown as Model3DGenerationSchema);
    }

    return withPreview({ $type: 'polyGen', input }, ctx.baseStepIndex);
  }
);

export const createTripoInput = defineHandler<EcosystemData<'Tripo'>, StepInput[]>((data, ctx) => {
  const input =
    data.tripoVersion === 'h3.1'
      ? toTripoH31PolyGenInput({
          ...data,
          sourceImages: data.images ?? [],
        } as unknown as TripoH31GenerationData)
      : (toTripoPolyGenInput({
          ...data,
          ...(data.images?.[0] ? { sourceImage: data.images[0] } : {}),
        } as unknown as TripoGenerationSchema) as TripoFalPolyGenInput);
  const step: PolyGenStepTemplate = { $type: 'polyGen', input };
  // Quad topology is FBX-only: there is no GLB for the preview renderer to load.
  if (input.quad) return [step] as unknown as StepInput[];
  return withPreview(step, ctx.baseStepIndex);
});

export const createHunyuan3dInput = defineHandler<EcosystemData<'Hunyuan3D'>, StepInput[]>(
  (data, ctx) => {
    const {
      images,
      hunyuanPrompt,
      hunyuanModelVersion,
      hunyuanSteps,
      hunyuanCfgScale,
      hunyuanOctreeResolution,
      ...rest
    } = data;

    const input = toHunyuan3dPolyGenInput({
      ...rest,
      ...(images?.[0] ? { sourceImage: images[0] } : {}),
      // empty prompt ⇒ omit (Hunyuan3D treats the prompt as an optional hint)
      prompt: hunyuanPrompt ? hunyuanPrompt : undefined,
      modelVersion: hunyuanModelVersion,
      steps: hunyuanSteps,
      cfgScale: hunyuanCfgScale,
      octreeResolution: hunyuanOctreeResolution,
    } as unknown as Hunyuan3dGenerationSchema) as Hunyuan3dImageTo3dComfyPolyGenInput;

    return withPreview({ $type: 'polyGen', input }, ctx.baseStepIndex);
  }
);

export const createPixal3dInput = defineHandler<EcosystemData<'Pixal3D'>, StepInput[]>(
  (data, ctx) => {
    const sourceImage = data.images?.[0];
    const input = toPixal3dPolyGenInput({
      ...data,
      ...(sourceImage ? { sourceImage } : {}),
    } as unknown as Pixal3dGenerationSchema) as Trellis2ImageTo3dComfyPolyGenInput;
    return withPreview({ $type: 'polyGen', input }, ctx.baseStepIndex);
  }
);

export const createTrellis2Input = defineHandler<EcosystemData<'Trellis2'>, StepInput[]>(
  (data, ctx) => {
    const sourceImage = data.images?.[0];
    const input = toTrellis2PolyGenInput({
      ...data,
      ...(sourceImage ? { sourceImage } : {}),
    } as unknown as Trellis2GenerationSchema) as Trellis2ImageTo3dComfyPolyGenInput;
    return withPreview({ $type: 'polyGen', input }, ctx.baseStepIndex);
  }
);
