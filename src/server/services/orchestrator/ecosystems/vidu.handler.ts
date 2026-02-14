/**
 * Vidu Ecosystem Handler
 *
 * Handles Vidu Q1 video generation workflows using videoGen step type.
 * Supports txt2vid, img2vid (with first/last frame), and ref2vid workflows.
 */

import type { ViduVideoGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type ViduCtx = EcosystemGraphOutput & { ecosystem: 'Vidu' };

/**
 * Creates videoGen input for Vidu ecosystem.
 * Supports txt2vid, img2vid (first/last frame), and img2vid:ref2vid workflows.
 */
export const createViduInput = defineHandler<ViduCtx, ViduVideoGenInput>((data, ctx) => {
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
});
