/**
 * Grok Ecosystem Handler
 *
 * Handles xAI Grok Imagine workflows for both image and video generation.
 * Image workflows use imageGen step type, video workflows use videoGen step type.
 *
 * Image operations:
 * - createImage: Text to image (GrokCreateImageGenInput)
 * - editImage: Edit with source images (GrokEditImageGenInput)
 *
 * Video operations:
 * - text-to-video: Text to video (GrokTextToVideoInput)
 * - image-to-video: Image to video (GrokImageToVideoInput)
 */

import type {
  GrokCreateImageGenInput,
  GrokEditImageGenInput,
  GrokTextToVideoInput,
  GrokImageToVideoInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { grokVideoAspectRatiosByResolution } from '~/shared/data-graph/generation/grok-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type GrokCtx = EcosystemGraphOutput & { ecosystem: 'Grok' };

// Image input union
type GrokImageInput = GrokCreateImageGenInput | GrokEditImageGenInput;

// Video input union
type GrokVideoInput = GrokTextToVideoInput | GrokImageToVideoInput;

/**
 * Creates imageGen input for Grok image workflows.
 * Handles both createImage and editImage operations.
 */
export const createGrokImageInput = defineHandler<GrokCtx, GrokImageInput>((data) => {
  const hasImages = !!data.images?.length;

  const baseData = {
    engine: 'grok',
    prompt: data.prompt,
    quantity: data.quantity ?? 1,
    aspectRatio: data.aspectRatio?.value,
  };

  if (hasImages) {
    return removeEmpty({
      ...baseData,
      operation: 'editImage',
      images: data.images!.map((x) => x.url),
    }) as GrokEditImageGenInput;
  }

  return removeEmpty({
    ...baseData,
    operation: 'createImage',
  }) as GrokCreateImageGenInput;
});

/**
 * Creates videoGen input for Grok video workflows.
 * Handles both text-to-video and image-to-video operations.
 */
export const createGrokVideoInput = defineHandler<GrokCtx, GrokVideoInput>((data) => {
  const hasImages = !!data.images?.length;
  const resolution = 'resolution' in data ? (data.resolution as string) : '720p';

  const baseData = {
    engine: 'grok',
    prompt: data.prompt,
    duration: 'duration' in data ? data.duration : undefined,
    resolution,
  };

  if (hasImages) {
    const ratioEntries =
      grokVideoAspectRatiosByResolution[resolution] ?? grokVideoAspectRatiosByResolution['720p'];
    const aspectRatio = findClosestAspectRatio(data.images![0], ratioEntries);
    return removeEmpty({
      ...baseData,
      operation: 'image-to-video',
      aspectRatio: aspectRatio?.value as GrokImageToVideoInput['aspectRatio'],
      images: [data.images![0].url] as [string],
    }) as GrokImageToVideoInput;
  }

  return removeEmpty({
    ...baseData,
    operation: 'text-to-video',
    aspectRatio: data.aspectRatio?.value as GrokTextToVideoInput['aspectRatio'],
  }) as GrokTextToVideoInput;
});
