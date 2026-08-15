/**
 * MiniMax (Hailuo) Ecosystem Handler
 *
 * Handles MiniMax H3 video generation using the videoGen step type.
 * Supports txt2vid, img2vid, first/last frame, and reference-image workflows.
 *
 * Two engines, selected by model version:
 * - `minimax-h3` — MiniMax's hosted API (aspect ratio + duration only)
 * - `minimax-h3-comfy` — local FL2VA/REF2VA weights, with LoRAs, seed, steps
 *   and the turbo LoRA toggle
 */

import type {
  ComfyMiniMaxH3ImageToVideoInput,
  ComfyMiniMaxH3ReferenceToVideoInput,
  MiniMaxH3VideoGenInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type MiniMaxCtx = EcosystemGraphOutput & { ecosystem: 'MiniMaxH3' };

/**
 * Creates videoGen input for the MiniMax ecosystem.
 */
export const createMiniMaxInput = defineHandler<MiniMaxCtx, [VideoGenStepTemplate]>((data, ctx) => {
  const images = data.images;
  const isRef2Vid = data.workflow === 'img2vid:ref2vid';
  const hasImages = !!images?.length;

  // H3 rejects a text-less request on every workflow, images or not (2013).
  const prompt = data.prompt?.trim();
  if (!prompt) throw throwBadRequestError('A prompt is required for MiniMax H3');

  if (data.minimaxVariant === 'comfy') {
    const loras: Record<string, number> = {};
    for (const resource of data.resources ?? []) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }

    const shared = {
      engine: 'minimax-h3-comfy' as const,
      prompt,
      duration: data.duration,
      seed: data.seed,
      steps: data.steps,
      turbo: data.turbo,
      loras: Object.keys(loras).length > 0 ? loras : undefined,
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
    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          ...shared,
          operation: 'imageToVideo',
          firstFrame,
          lastFrame,
          // A supplied frame dictates the framing; only txt2vid needs explicit dimensions.
          width: firstFrame ? undefined : data.aspectRatio?.width,
          height: firstFrame ? undefined : data.aspectRatio?.height,
        }) as ComfyMiniMaxH3ImageToVideoInput,
      },
    ];
  }

  // ref2vid sends images as an array; the frame workflows use the first/last slots
  const firstFrameImage = !isRef2Vid && hasImages ? images?.[0]?.url : undefined;
  const lastFrameImage = !isRef2Vid && images && images.length > 1 ? images[1]?.url : undefined;
  const referenceImages = isRef2Vid && hasImages ? images?.map((x) => x.url) : undefined;

  return [
    {
      $type: 'videoGen',
      input: removeEmpty({
        engine: 'minimax-h3',
        prompt,
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
