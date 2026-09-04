/** MiniMax H3 handler for the form-graph lane — comfy build vs API build. */

import type {
  ComfyMiniMaxH3ImageToVideoInput,
  ComfyMiniMaxH3ReferenceToVideoInput,
  MiniMaxH3VideoGenInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { removeEmpty } from '~/utils/object-helpers';
import { resolveImageDimensions } from '~/utils/aspect-ratio-helpers';
import {
  MINIMAX_DEFAULT_ASPECT_RATIO,
  minimaxComfyAspectRatios,
} from '~/shared/form-graph/generation/video/minimax.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

const minimaxComfyDefaultAspectRatio =
  minimaxComfyAspectRatios.find((option) => option.value === MINIMAX_DEFAULT_ASPECT_RATIO) ??
  minimaxComfyAspectRatios[0];

export const createMiniMaxInput = defineHandler<EcosystemData<'MiniMaxH3'>, [VideoGenStepTemplate]>(
  (data, ctx) => {
    const images = data.images;
    const isRef2Vid = data.workflow === 'img2vid:ref2vid';
    const hasImages = !!images?.length;

    const prompt = data.prompt?.trim();
    if (!prompt) throw throwBadRequestError('A prompt is required for MiniMax H3');

    if (data.minimaxVariant === 'comfy') {
      const shared = {
        engine: 'minimax-h3-comfy' as const,
        prompt,
        duration: data.duration,
        seed: data.seed,
        steps: data.steps,
        turbo: data.turbo,
        loras: resourcesToLoras(data.resources, ctx.airs),
        diffusionModel: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
      };

      if (isRef2Vid) {
        const referenceImages = images?.map((x) => x.url) ?? [];
        if (!referenceImages.length)
          throw new Error('At least one reference image is required for img2vid:ref2vid');
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...shared,
              operation: 'referenceToVideo',
              images: referenceImages,
              width: data.aspectRatio?.width,
              height: data.aspectRatio?.height,
            }) as ComfyMiniMaxH3ReferenceToVideoInput,
          },
        ];
      }

      const firstFrame = hasImages ? images?.[0]?.url : undefined;
      const lastFrame = images && images.length > 1 ? images[1]?.url : undefined;
      const { width, height } = resolveImageDimensions(
        images?.[0],
        minimaxComfyAspectRatios,
        data.aspectRatio ?? minimaxComfyDefaultAspectRatio
      );
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...shared,
            operation: 'imageToVideo',
            firstFrame,
            lastFrame,
            width,
            height,
          }) as ComfyMiniMaxH3ImageToVideoInput,
        },
      ];
    }

    const firstFrameImage = !isRef2Vid && hasImages ? images?.[0]?.url : undefined;
    const lastFrameImage = !isRef2Vid && images && images.length > 1 ? images[1]?.url : undefined;
    const referenceImages = isRef2Vid && hasImages ? images?.map((x) => x.url) : undefined;

    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          engine: 'minimax-h3',
          prompt,
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
  }
);
