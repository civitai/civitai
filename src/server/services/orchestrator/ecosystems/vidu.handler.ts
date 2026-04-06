/**
 * Vidu Ecosystem Handler
 *
 * Handles Vidu video generation workflows using videoGen step type.
 * Supports Q1 and Q3 model versions with different engine types.
 * Q1: txt2vid, img2vid (first/last frame), ref2vid
 * Q3: txt2vid, img2vid, ref2vid with resolution/turbo/audio options
 */

import type { ViduVideoGenInput, ViduQ3VideoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { viduVersionIds } from '~/shared/data-graph/generation/vidu-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type ViduCtx = EcosystemGraphOutput & { ecosystem: 'Vidu' };

/**
 * Creates videoGen input for Vidu ecosystem.
 * Routes to Q1 (engine: 'vidu') or Q3 (engine: 'vidu-q3') based on selected model version.
 */
export const createViduInput = defineHandler<ViduCtx, [VideoGenStepTemplate]>((data, ctx) => {
  const modelId = data.model?.id;
  const isQ3 = modelId === viduVersionIds.q3;

  const input = isQ3 ? createQ3Input(data) : createQ1Input(data);
  return [{ $type: 'videoGen', input }];
});

/** Creates Q1 videoGen input (engine: 'vidu') */
function createQ1Input(data: ViduCtx): ViduVideoGenInput {
  const images = data.images;
  const isRef2Vid = data.workflow === 'img2vid:ref2vid';
  const isFirstLastFrame = data.workflow === 'img2vid';

  // For ref2vid: generate placeholder prompt if user didn't provide one
  const prompt =
    isRef2Vid && !data.prompt.length && images?.length
      ? images.map((_, index) => `[@image${index + 1}]`).join()
      : data.prompt;

  // Map images to the correct API properties based on workflow:
  // - txt2vid (with images): first image → sourceImage (after normalization)
  // - img2vid: first → sourceImage, second → endSourceImage
  // - img2vid:ref2vid: all images → images array
  const sourceImage = !isRef2Vid && images?.length ? images[0]?.url : undefined;
  const endSourceImage =
    isFirstLastFrame && images && images.length > 1 ? images[1]?.url : undefined;
  const refImages = isRef2Vid ? images?.map((x) => x.url) : undefined;

  return removeEmpty({
    engine: 'vidu',
    model: 'q1' as ViduVideoGenInput['model'],
    prompt,
    aspectRatio: data.aspectRatio?.value as ViduVideoGenInput['aspectRatio'],
    style: 'style' in data ? data.style : undefined,
    movementAmplitude: 'movementAmplitude' in data ? data.movementAmplitude : undefined,
    sourceImage,
    endSourceImage,
    images: refImages,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    enablePromptEnhancer: 'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
  }) as ViduVideoGenInput;
}

/** Creates Q3 videoGen input (engine: 'vidu-q3') */
function createQ3Input(data: ViduCtx): ViduQ3VideoGenInput {
  const images = data.images;
  const isRef2Vid = data.workflow === 'img2vid:ref2vid';

  // For ref2vid: generate placeholder prompt if user didn't provide one
  const prompt =
    isRef2Vid && !data.prompt.length && images?.length
      ? images.map((_, index) => `[@image${index + 1}]`).join()
      : data.prompt;

  // Q3 uses images array for all image workflows
  const imageUrls = images?.length ? images.map((x) => x.url) : undefined;

  return removeEmpty({
    engine: 'vidu-q3',
    prompt,
    aspectRatio: data.aspectRatio?.value as ViduQ3VideoGenInput['aspectRatio'],
    resolution:
      'resolution' in data ? (data.resolution as ViduQ3VideoGenInput['resolution']) : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    turbo: 'draft' in data ? data.draft : undefined,
    enableAudio: 'enableAudio' in data ? data.enableAudio : undefined,
    images: imageUrls,
    quantity: data.quantity ?? 1,
    seed: data.seed,
  }) as ViduQ3VideoGenInput;
}
