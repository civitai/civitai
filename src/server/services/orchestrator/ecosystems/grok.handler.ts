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
 * - edit-video: Edit video with AI (GrokEditVideoInput)
 */

import type {
  GrokCreateImageGenInput,
  GrokEditImageGenInput,
  GrokTextToVideoInput,
  GrokImageToVideoInput,
  GrokEditVideoInput,
  ImageGenStepTemplate,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { grokVideoAspectRatiosByResolution } from '~/shared/data-graph/generation/grok-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type GrokCtx = EcosystemGraphOutput & { ecosystem: 'Grok' };

/**
 * Creates imageGen input for Grok image workflows.
 * Handles both createImage and editImage operations.
 */
export const createGrokImageInput = defineHandler<GrokCtx, [ImageGenStepTemplate]>((data) => {
  const hasImages = !!data.images?.length;

  const baseData = {
    engine: 'grok',
    prompt: data.prompt,
    quantity: data.quantity ?? 1,
    aspectRatio: data.aspectRatio?.value,
  };

  if (hasImages) {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseData,
          operation: 'editImage',
          images: data.images!.map((x) => x.url),
        }) as GrokEditImageGenInput,
      },
    ];
  }

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        ...baseData,
        operation: 'createImage',
      }) as GrokCreateImageGenInput,
    },
  ];
});

/**
 * Creates videoGen input for Grok video workflows.
 * Handles text-to-video, image-to-video, and edit-video operations.
 */
export const createGrokVideoInput = defineHandler<GrokCtx, [VideoGenStepTemplate]>((data) => {
  const hasImages = !!data.images?.length;
  const hasVideo = 'video' in data && !!data.video;
  const resolution = 'resolution' in data ? (data.resolution as string) : '720p';

  const baseData = {
    engine: 'grok',
    prompt: data.prompt,
    duration: 'duration' in data ? data.duration : undefined,
    resolution,
  };

  // Edit video (vid2vid:edit)
  if (hasVideo) {
    const video = data.video as { url: string; metadata?: { duration?: number } };
    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          ...baseData,
          operation: 'edit-video',
          videoUrl: video.url,
          analyzedDuration: video.metadata?.duration,
        }) as GrokEditVideoInput,
      },
    ];
  }

  // Image to video (img2vid)
  if (hasImages) {
    const ratioEntries =
      grokVideoAspectRatiosByResolution[resolution] ?? grokVideoAspectRatiosByResolution['720p'];
    const aspectRatio = findClosestAspectRatio(data.images![0], ratioEntries);
    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          ...baseData,
          operation: 'image-to-video',
          aspectRatio: aspectRatio?.value as GrokImageToVideoInput['aspectRatio'],
          images: [data.images![0].url] as [string],
        }) as GrokImageToVideoInput,
      },
    ];
  }

  // Text to video (txt2vid)
  return [
    {
      $type: 'videoGen',
      input: removeEmpty({
        ...baseData,
        operation: 'text-to-video',
        aspectRatio: data.aspectRatio?.value as GrokTextToVideoInput['aspectRatio'],
      }) as GrokTextToVideoInput,
    },
  ];
});
