/** Vidu handler for the form-graph lane — Q1 (`vidu`) vs Q3 (`vidu-q3`) engines. */

import type { ViduVideoGenInput, ViduQ3VideoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { viduVersionIds } from '~/shared/form-graph/generation/video/vidu.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

export const createViduInput = defineHandler<LooseGenerationData, [VideoGenStepTemplate]>(
  (data) => {
    const isQ3 = data.model?.id === viduVersionIds.q3;
    const input = isQ3 ? createQ3Input(data) : createQ1Input(data);
    return [{ $type: 'videoGen', input }];
  }
);

function refPlaceholderPrompt(data: LooseGenerationData, isRef2Vid: boolean) {
  return isRef2Vid && !data.prompt?.length && data.images?.length
    ? data.images.map((_, index) => `[@image${index + 1}]`).join()
    : data.prompt;
}

function createQ1Input(data: LooseGenerationData): ViduVideoGenInput {
  const images = data.images;
  const isRef2Vid = data.workflow === 'img2vid:ref2vid';
  const isFirstLastFrame = data.workflow === 'img2vid';

  // txt2vid with images: first image → sourceImage; img2vid: first → sourceImage,
  // second → endSourceImage; ref2vid: all → images array
  const sourceImage = !isRef2Vid && images?.length ? images[0]?.url : undefined;
  const endSourceImage =
    isFirstLastFrame && images && images.length > 1 ? images[1]?.url : undefined;
  const refImages = isRef2Vid ? images?.map((x) => x.url) : undefined;

  return removeEmpty({
    engine: 'vidu',
    model: 'q1' as ViduVideoGenInput['model'],
    prompt: refPlaceholderPrompt(data, isRef2Vid),
    aspectRatio: data.aspectRatio?.value as ViduVideoGenInput['aspectRatio'],
    style: (data as { style?: string }).style,
    movementAmplitude: (data as { movementAmplitude?: string }).movementAmplitude,
    sourceImage,
    endSourceImage,
    images: refImages,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    enablePromptEnhancer: (data as { enablePromptEnhancer?: boolean }).enablePromptEnhancer,
  }) as ViduVideoGenInput;
}

function createQ3Input(data: LooseGenerationData): ViduQ3VideoGenInput {
  const images = data.images;
  const isRef2Vid = data.workflow === 'img2vid:ref2vid';

  return removeEmpty({
    engine: 'vidu-q3',
    prompt: refPlaceholderPrompt(data, isRef2Vid),
    aspectRatio: data.aspectRatio?.value as ViduQ3VideoGenInput['aspectRatio'],
    resolution: (data as { resolution?: ViduQ3VideoGenInput['resolution'] }).resolution,
    duration: (data as { duration?: number }).duration,
    turbo: (data as { draft?: boolean }).draft,
    enableAudio: (data as { enableAudio?: boolean }).enableAudio,
    images: images?.length ? images.map((x) => x.url) : undefined,
    quantity: data.quantity ?? 1,
    seed: data.seed,
  }) as ViduQ3VideoGenInput;
}
