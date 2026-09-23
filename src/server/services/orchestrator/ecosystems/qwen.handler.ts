/**
 * Qwen Family Handler
 *
 * Handles Qwen, Qwen 2, Qwen 2.1 and Qwen 3 workflows using imageGen step type.
 * Discriminates between ecosystems:
 * - Qwen: comfy engine, model version-based routing, LoRA support
 * - Qwen 2: fal engine, aspect ratio mapped to imageSize enum
 * - Qwen 2.1: comfy engine, unified generation/editing, release-specific LoRAs
 * - Qwen 3: qwen engine (Alibaba DashScope), explicit width/height
 */

import type {
  Qwen2CreateFalImageGenInput,
  Qwen2EditFalImageGenInput,
  QwenApiCreateImageGenInput,
  QwenApiEditImageGenInput,
} from '@civitai/client';
import type {
  ImageGenStepTemplate,
  ComfyQwen21CreateImageGenInput,
  ComfyQwen21EditImageGenInputWritable,
  ComfyQwen20bCreateImageGenInput,
  ComfyQwen20bEditImageGenInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type QwenFamilyCtx = EcosystemGraphOutput & { ecosystem: 'Qwen' | 'Qwen2' | 'Qwen21' | 'Qwen3' };

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
// Qwen 3 model identifiers
// =============================================================================

const QWEN3_CREATE_MODEL: QwenApiCreateImageGenInput['model'] = '3.0-pro';
const QWEN3_EDIT_MODEL: QwenApiEditImageGenInput['model'] = '3.0-pro';

// =============================================================================
// Unified handler
// =============================================================================

/**
 * Creates imageGen input for Qwen family ecosystems.
 * Routes to Qwen (comfy), Qwen 2 (fal) or Qwen 3 (qwen) based on ecosystem.
 */
export const createQwenInput = defineHandler<QwenFamilyCtx, [ImageGenStepTemplate]>((data, ctx) => {
  const isTxt2Img = data.workflow.startsWith('txt');
  const quantity = data.quantity ?? 1;

  // Qwen 2.1 — unified generation/editing with its own LoRA compatibility
  if (data.ecosystem === 'Qwen21') {
    if (!('resolution' in data)) throw new Error('Qwen 2.1 settings are required');
    const loras: Record<string, number> = {};
    for (const resource of data.resources ?? []) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
    const baseInput = {
      engine: 'comfy' as const,
      ecosystem: 'qwen' as const,
      model: '2.1' as const,
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      steps: data.steps,
      cfgScale: data.cfgScale,
      sampler: 'euler' as const,
      scheduler: 'simple' as const,
      quantity,
      seed: data.seed,
      loras: Object.keys(loras).length ? loras : undefined,
      outputFormat: data.outputFormat,
    };
    if (isTxt2Img) {
      if (!data.aspectRatio) throw new Error('Aspect ratio is required');
      const input = {
        ...baseInput,
        operation: 'createImage',
        width: data.aspectRatio.width,
        height: data.aspectRatio.height,
      } satisfies ComfyQwen21CreateImageGenInput;
      return [{ $type: 'imageGen', input: removeEmpty(input) }];
    }
    const input = {
      ...baseInput,
      operation: 'editImage',
      resolution: data.resolution === '2K' ? 2048 : 1024,
      images: data.images?.map((image) => image.url) ?? [],
    } satisfies ComfyQwen21EditImageGenInputWritable;
    return [{ $type: 'imageGen', input: removeEmpty(input) }];
  }

  // Qwen 3 — qwen engine (Alibaba DashScope)
  if (data.ecosystem === 'Qwen3') {
    const baseInput = {
      engine: 'qwen' as const,
      prompt: data.prompt,
      negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
      width: data.aspectRatio?.width,
      height: data.aspectRatio?.height,
      promptExtend: 'enablePromptExpansion' in data ? data.enablePromptExpansion : undefined,
      quantity,
      seed: data.seed,
    };

    if (isTxt2Img) {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            ...baseInput,
            model: QWEN3_CREATE_MODEL,
            operation: 'createImage',
          }) as QwenApiCreateImageGenInput,
        },
      ];
    }
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          model: QWEN3_EDIT_MODEL,
          operation: 'editImage',
          images: data.images?.map((x) => x.url) ?? [],
        }) as QwenApiEditImageGenInput,
      },
    ];
  }

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

  // Qwen — comfy engine
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
    engine: 'comfy',
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
        }) as ComfyQwen20bCreateImageGenInput,
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
      }) as ComfyQwen20bEditImageGenInput,
    },
  ];
});
