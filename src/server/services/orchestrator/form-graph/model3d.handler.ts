/**
 * The 3D families' handlers for the form-graph lane. Each converts parsed
 * data into a `PolyGenStepTemplate` via the shared schema builders, then
 * chains the `model3DPreview` step. PolyGen branches on `version` (v6
 * text/image vs v7 image/multi-image); the trellis-pipeline pair
 * (Pixal3D / Trellis.2) and Tripo v2.5 map `images[0]` → `sourceImage`;
 * Tripo H3.1 branches on text, one image, or 2–4 views (multiview).
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
  TripoH31ImageTo3dFalPolyGenInput,
  TripoH31MultiviewTo3dFalPolyGenInput,
  TripoH31TextTo3dFalPolyGenInput,
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
import { removeEmpty } from '~/utils/object-helpers';
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
    const { mode, ...rest } = data;
    const images = data.images ?? [];

    let input:
      | MeshyTextTo3dFalPolyGenInput
      | MeshyImageTo3dFalPolyGenInput
      | MeshyV7ImageTo3dFalPolyGenInput
      | MeshyV7MultiImageTo3dFalPolyGenInput;

    if (data.version === 'v7') {
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
        ...(mode !== undefined ? { mode } : {}),
        ...(sourceImage ? { sourceImage } : {}),
      } as unknown as Model3DGenerationSchema);
    }

    return withPreview({ $type: 'polyGen', input }, ctx.baseStepIndex);
  }
);

export const createTripoInput = defineHandler<EcosystemData<'Tripo'>, StepInput[]>((data, ctx) => {
  const input = data.version === 'h3.1' ? toTripoH31Input(data) : toTripoV25Input(data);
  // Quad topology is FBX-only: there is no GLB for the preview renderer to load.
  if (input.quad) return [{ $type: 'polyGen', input }] as unknown as StepInput[];
  return withPreview({ $type: 'polyGen', input }, ctx.baseStepIndex);
});

type TripoData = EcosystemData<'Tripo'>;
type TripoH31Input =
  | TripoH31TextTo3dFalPolyGenInput
  | TripoH31ImageTo3dFalPolyGenInput
  | TripoH31MultiviewTo3dFalPolyGenInput;

function toTripoV25Input(data: TripoData): TripoFalPolyGenInput {
  const sourceImage = data.images?.[0];
  return toTripoPolyGenInput({
    ...data,
    pbr: data.enablePbr,
    ...(sourceImage ? { sourceImage } : {}),
  } as unknown as TripoGenerationSchema);
}

function toTripoH31Input(data: TripoData): TripoH31Input {
  const shared = {
    engine: 'fal' as const,
    model: 'tripo' as const,
    version: 'h3.1' as const,
    texture: data.texture !== 'no',
    textureQuality: data.texture === 'HD' ? ('detailed' as const) : ('standard' as const),
    geometryQuality: data.geometryQuality,
    pbr: data.enablePbr,
    quad: data.quad,
    autoSize: data.autoSize,
    faceLimit: data.faceLimit,
    seed: data.seed,
    textureSeed: data.textureSeed,
  };

  if (data.workflow.startsWith('txt')) {
    return removeEmpty<TripoH31TextTo3dFalPolyGenInput>({
      ...shared,
      operation: 'textTo3D',
      prompt: data.prompt ?? '',
      // text-to-3D renders an image first; one seed control pins both stages
      imageSeed: shared.seed,
    });
  }

  const imageUrls = (data.images ?? []).map((image) => image.url);
  const imageShared = {
    ...shared,
    textureAlignment: data.textureAlignment,
    orientation: data.orientation,
  };
  if (imageUrls.length > 1) {
    return removeEmpty<TripoH31MultiviewTo3dFalPolyGenInput>({
      ...imageShared,
      operation: 'multiviewTo3D',
      imageUrls,
    });
  }
  return removeEmpty<TripoH31ImageTo3dFalPolyGenInput>({
    ...imageShared,
    operation: 'imageTo3D',
    imageUrl: imageUrls[0],
  });
}

export const createHunyuan3dInput = defineHandler<EcosystemData<'Hunyuan3D'>, StepInput[]>(
  (data, ctx) => {
    const { images, prompt, version, ...rest } = data;

    const input = toHunyuan3dPolyGenInput({
      ...rest,
      ...(images?.[0] ? { sourceImage: images[0] } : {}),
      // empty prompt ⇒ omit (Hunyuan3D treats the prompt as an optional hint)
      prompt: prompt ? prompt : undefined,
      modelVersion: version,
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
