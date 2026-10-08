/** Vidu handler for the form-graph lane — Q1 (`vidu`), Q3 (`vidu-q3`) and Q4 (`vidu-q4`) engines. */

import type { ViduVideoGenInput, ViduQ3VideoGenInput, VideoGenStepTemplate } from '@civitai/client';
import type {
  ViduQ4ImageToVideoInput,
  ViduQ4ReferenceToVideoInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { viduVersionIds } from '~/shared/form-graph/generation/video/vidu.graph';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

type ViduData = EcosystemData<'Vidu'>;

export const createViduInput = defineHandler<ViduData, [VideoGenStepTemplate]>((data) => {
  const modelId = data.model?.id;
  if (modelId === viduVersionIds.q4)
    return [{ $type: 'videoGen', input: createQ4Input(data) } as VideoGenStepTemplate];
  const input = modelId === viduVersionIds.q3 ? createQ3Input(data) : createQ1Input(data);
  return [{ $type: 'videoGen', input }];
});

function refPlaceholderPrompt(data: ViduData, isRef2Vid: boolean) {
  return isRef2Vid && !data.prompt?.length && data.images?.length
    ? data.images.map((_, index) => `[@image${index + 1}]`).join()
    : data.prompt;
}

function createQ1Input(data: ViduData): ViduVideoGenInput {
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
    style: data.style,
    movementAmplitude: data.movementAmplitude,
    sourceImage,
    endSourceImage,
    images: refImages,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    enablePromptEnhancer: data.enablePromptEnhancer,
  }) as ViduVideoGenInput;
}

function createQ3Input(data: ViduData): ViduQ3VideoGenInput {
  const images = data.images;
  const isRef2Vid = data.workflow === 'img2vid:ref2vid';

  return removeEmpty({
    engine: 'vidu-q3',
    prompt: refPlaceholderPrompt(data, isRef2Vid),
    aspectRatio: data.aspectRatio?.value as ViduQ3VideoGenInput['aspectRatio'],
    resolution: data.resolution as ViduQ3VideoGenInput['resolution'],
    duration: data.duration,
    turbo: data.draft,
    enableAudio: data.enableAudio,
    images: images?.length ? images.map((x) => x.url) : undefined,
    quantity: data.quantity ?? 1,
    seed: data.seed,
  }) as ViduQ3VideoGenInput;
}

/** Q4 has no text-to-video: anything that is not ref2vid animates the first image. */
function createQ4Input(data: ViduData): ViduQ4ImageToVideoInput | ViduQ4ReferenceToVideoInput {
  const images = data.images?.map((x) => x.url) ?? [];
  const common = {
    engine: 'vidu-q4' as const,
    resolution: data.resolution as ViduQ4ImageToVideoInput['resolution'],
    duration: data.duration,
    quantity: data.quantity ?? 1,
    seed: data.seed,
  };

  if (data.workflow === 'img2vid:ref2vid') {
    // Q4 names references [@reference_image_N], not Q1/Q3's [@imageN]
    const prompt =
      !data.prompt?.length && images.length
        ? images.map((_, index) => `[@reference_image_${index + 1}]`).join()
        : data.prompt;
    return removeEmpty({
      ...common,
      operation: 'referenceToVideo' as const,
      prompt,
      referenceImages: images,
      aspectRatio: data.aspectRatio?.value as ViduQ4ReferenceToVideoInput['aspectRatio'],
      enableAudio: data.enableAudio,
    }) as ViduQ4ReferenceToVideoInput;
  }

  const image = images[0];
  if (!image) throw new Error('Vidu Q4 needs a starting image');
  return removeEmpty({
    ...common,
    operation: 'imageToVideo' as const,
    prompt: data.prompt,
    image,
  }) as ViduQ4ImageToVideoInput;
}
