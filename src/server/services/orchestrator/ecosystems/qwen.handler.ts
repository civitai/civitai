/**
 * Qwen Family Handler
 *
 * Handles Qwen and Qwen 2 workflows using imageGen step type.
 * Discriminates between ecosystems:
 * - Qwen: sdcpp engine, model version-based routing, LoRA support
 * - Qwen 2: fal engine, aspect ratio mapped to imageSize enum
 */

import type {
  Qwen20bCreateImageGenInput,
  Qwen20bEditImageGenInput,
  Qwen2CreateFalImageGenInput,
  Qwen2EditFalImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type QwenFamilyCtx = EcosystemGraphOutput & { ecosystem: 'Qwen' | 'Qwen2' };

// =============================================================================
// Qwen version mapping
// =============================================================================

type Txt2ImgVersion = '2509' | '2512';
type Img2ImgVersion = '2509' | '2511';
const qwenModelVersionMap = new Map<
  number,
  { process: 'txt2img' | 'img2img'; version: Txt2ImgVersion | Img2ImgVersion }
>([
  [2110043, { process: 'txt2img', version: '2509' }],
  [2552908, { process: 'txt2img', version: '2512' }],
  [2133258, { process: 'img2img', version: '2509' }],
  [2558804, { process: 'img2img', version: '2511' }],
]);

// =============================================================================
// Qwen 2 imageSize mapping
// =============================================================================

/** Map standard aspect ratio values to fal imageSize enum */
const imageSizeMap: Record<string, Qwen2CreateFalImageGenInput['imageSize']> = {
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
};

// =============================================================================
// Unified handler
// =============================================================================

/**
 * Creates imageGen input for Qwen family ecosystems.
 * Routes to Qwen (sdcpp) or Qwen 2 (fal) based on ecosystem.
 */
export const createQwenInput = defineHandler<QwenFamilyCtx, [ImageGenStepTemplate]>((data, ctx) => {
  const isTxt2Img = data.workflow.startsWith('txt');
  const quantity = data.quantity ?? 1;

  // Qwen 2 — fal engine
  if (data.ecosystem === 'Qwen2') {
    const imageSize = data.aspectRatio?.value ? imageSizeMap[data.aspectRatio.value] : undefined;

    const baseInput = {
      engine: 'fal' as const,
      model: 'qwen2' as const,
      prompt: data.prompt,
      negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
      imageSize,
      quantity,
      seed: data.seed,
    };

    if (isTxt2Img) {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            ...baseInput,
            operation: 'createImage',
          }) as Qwen2CreateFalImageGenInput,
        },
      ];
    }
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          operation: 'editImage',
          images: data.images?.map((x) => x.url) ?? [],
        }) as Qwen2EditFalImageGenInput,
      },
    ];
  }

  // Qwen — sdcpp engine
  let process: 'txt2img' | 'img2img' = 'txt2img';
  let version: Txt2ImgVersion | Img2ImgVersion = '2512';
  if (data.model) {
    const match = qwenModelVersionMap.get(data.model.id);
    if (match) {
      process = match.process;
      version = match.version;
    }
  }

  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }

  const baseInput = {
    engine: 'sdcpp',
    ecosystem: 'qwen',
    model: '20b' as const,
    version,
    prompt: data.prompt,
    negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
    steps: 'steps' in data ? data.steps : undefined,
    quantity,
    seed: data.seed,
    loras: Object.keys(loras).length > 0 ? loras : undefined,
  };

  if (process === 'txt2img') {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          operation: 'createImage',
        }) as Qwen20bCreateImageGenInput,
      },
    ];
  }
  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        ...baseInput,
        operation: 'editImage',
        images: data.images?.map((x) => x.url) ?? [],
      }) as Qwen20bEditImageGenInput,
    },
  ];
});
