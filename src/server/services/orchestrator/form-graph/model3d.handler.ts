/**
 * The 3D families' handlers for the form-graph lane. Each converts parsed
 * data into a `PolyGenStepTemplate` via the same shared schema builders the
 * v1 handlers use, then chains the `model3DPreview` step. PolyGen branches on
 * `polygenVersion` (v6 text/image vs v7 image/multi-image); Hunyuan3D maps
 * its `hunyuan*`-prefixed fields back to schema names; the trellis-pipeline
 * pair (Pixal3D / Trellis.2) and Tripo map `images[0]` → `sourceImage`.
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
} from '@civitai/client';
import {
  toMeshyPolyGenInput,
  type Model3DGenerationSchema,
} from '~/server/orchestrator/polygen/polygen.schema';
import {
  toMeshyV7PolyGenInput,
  type PolyGenV7GenerationSchema,
} from '~/server/orchestrator/polygen/polygen-v7.schema';
import {
  toTripoPolyGenInput,
  type TripoGenerationSchema,
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
import { defineHandler } from '../ecosystems/handler-factory';
import { buildModel3DPreviewStep } from '../ecosystems/model3d-preview';
import type { StepInput } from '../ecosystems';
import type { EcosystemData } from './types';

// The shared `StepInput` union lists neither `PolyGenStepTemplate` nor the
// (client-untyped) `model3DPreview` step, but the orchestrator queue accepts
// both natively — same cast the v1 handlers carry.
const withPreview = (step: PolyGenStepTemplate, baseStepIndex: number): StepInput[] =>
  [step, buildModel3DPreviewStep(baseStepIndex)] as unknown as StepInput[];

export const createPolyGenInput = defineHandler<EcosystemData<'PolyGen'>, StepInput[]>(
  (data, ctx) => {
    const { polygenMode, ...rest } = data;
    const images = data.images ?? [];

    let input:
      | MeshyTextTo3dFalPolyGenInput
      | MeshyImageTo3dFalPolyGenInput
      | MeshyV7ImageTo3dFalPolyGenInput
      | MeshyV7MultiImageTo3dFalPolyGenInput;

    if (data.polygenVersion === 'v7') {
      input = toMeshyV7PolyGenInput({
        ...rest,
        sourceImages: images,
      } as unknown as PolyGenV7GenerationSchema);
    } else {
      const process = data.workflow?.startsWith('txt') ? 'textTo3D' : 'imageTo3D';
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
  const sourceImage = data.images?.[0];
  const input = toTripoPolyGenInput({
    ...data,
    ...(sourceImage ? { sourceImage } : {}),
  } as unknown as TripoGenerationSchema) as TripoFalPolyGenInput;
  return withPreview({ $type: 'polyGen', input }, ctx.baseStepIndex);
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
