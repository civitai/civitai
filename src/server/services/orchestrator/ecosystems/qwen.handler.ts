/**
 * Qwen Ecosystem Handler
 *
 * Handles Qwen workflows using imageGen step type.
 * Supports txt2img (createImage) and img2img (editImage) operations.
 */

import type { Qwen20bCreateImageGenInput, Qwen20bEditImageGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type QwenCtx = EcosystemGraphOutput & { baseModel: 'Qwen' };

// Return type union
type QwenInput = Qwen20bCreateImageGenInput | Qwen20bEditImageGenInput;

// Model version mapping
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

/**
 * Creates imageGen input for Qwen ecosystem.
 * Handles both txt2img and img2img operations based on model version.
 */
export const createQwenInput = defineHandler<QwenCtx, QwenInput>((data, ctx) => {
  const quantity = data.quantity ?? 1;

  // Determine process type and version from model
  let process: 'txt2img' | 'img2img' = 'txt2img';
  let version: Txt2ImgVersion | Img2ImgVersion = '2512';
  if (data.model) {
    const match = qwenModelVersionMap.get(data.model.id);
    if (match) {
      process = match.process;
      version = match.version;
    }
  }

  // Build loras from additional resources (excluding checkpoint)
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
    return removeEmpty({
      ...baseInput,
      operation: 'createImage',
    }) as Qwen20bCreateImageGenInput;
  } else {
    return removeEmpty({
      ...baseInput,
      operation: 'editImage',
      images: data.images?.map((x) => x.url) ?? [],
    }) as Qwen20bEditImageGenInput;
  }
});
