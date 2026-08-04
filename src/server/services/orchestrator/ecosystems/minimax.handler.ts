/**
 * MiniMax (Hailuo) Ecosystem Handler
 *
 * Handles MiniMax H3 video generation using the videoGen step type.
 * Supports txt2vid, img2vid, first/last frame, and reference-image workflows.
 */

import type { MiniMaxH3VideoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type MiniMaxCtx = EcosystemGraphOutput & { ecosystem: 'MiniMaxH3' };

/**
 * Creates videoGen input for the MiniMax ecosystem.
 */
export const createMiniMaxInput = defineHandler<MiniMaxCtx, [VideoGenStepTemplate]>((data) => {
  const images = data.images;
  const isRef2Vid = data.workflow === 'img2vid:ref2vid';
  const hasImages = !!images?.length;

  // ref2vid sends images as an array; the frame workflows use the first/last slots
  const firstFrameImage = !isRef2Vid && hasImages ? images?.[0]?.url : undefined;
  const lastFrameImage = !isRef2Vid && images && images.length > 1 ? images[1]?.url : undefined;
  const referenceImages = isRef2Vid && hasImages ? images?.map((x) => x.url) : undefined;

  return [
    {
      $type: 'videoGen',
      input: removeEmpty({
        engine: 'minimax-h3',
        prompt: data.prompt,
        // A supplied frame dictates the framing, so let the provider adapt to it.
        aspectRatio: firstFrameImage
          ? 'adaptive'
          : (data.aspectRatio?.value as MiniMaxH3VideoGenInput['aspectRatio']),
        duration: data.duration,
        resolution: '2K',
        firstFrameImage,
        lastFrameImage,
        referenceImages,
      }) as MiniMaxH3VideoGenInput,
    },
  ];
});
