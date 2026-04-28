/**
 * HappyHorse Ecosystem Handler
 *
 * Handles Alibaba Taotian HappyHorse video generation (FAL).
 * Single version v1.0 with four operations selected by workflow:
 * - txt2vid          → operation 'textToVideo'      (HappyHorseV1TextToVideoInput)
 * - img2vid          → operation 'imageToVideo'     (HappyHorseV1ImageToVideoInput)
 * - img2vid:ref2vid  → operation 'referenceToVideo' (HappyHorseV1ReferenceToVideoInput)
 * - vid2vid:edit     → operation 'videoEdit'        (HappyHorseV1VideoEditInput)
 */

import type {
  HappyHorseV1TextToVideoInput,
  HappyHorseV1ImageToVideoInput,
  HappyHorseV1ReferenceToVideoInput,
  HappyHorseV1VideoEditInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type HappyHorseCtx = EcosystemGraphOutput & { ecosystem: 'HappyHorse' };

const ENGINE = 'happyHorse' as const;
const VERSION = 'v1.0' as const;

/**
 * Creates videoGen input for HappyHorse ecosystem.
 * Routes to the appropriate operation based on workflow.
 */
export const createHappyHorseInput = defineHandler<HappyHorseCtx, [VideoGenStepTemplate]>(
  (data) => {
    // enableSafetyChecker is in the type spec but intentionally not exposed —
    // matches peer video ecosystems and avoids double-filtering against Civitai's own NSFW pipeline.
    const base = {
      engine: ENGINE,
      version: VERSION,
      prompt: data.prompt,
      resolution:
        'resolution' in data
          ? (data.resolution as HappyHorseV1TextToVideoInput['resolution'])
          : undefined,
      duration: 'duration' in data ? data.duration : undefined,
      seed: data.seed,
    };

    // vid2vid:edit
    if (data.workflow === 'vid2vid:edit') {
      const video = 'video' in data ? data.video : undefined;
      if (!video?.url) throw new Error('A source video is required for vid2vid:edit');
      const referenceImages = data.images?.length ? data.images.map((x) => x.url) : undefined;
      const audioSetting =
        'audioSetting' in data
          ? (data.audioSetting as HappyHorseV1VideoEditInput['audioSetting'])
          : undefined;
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...base,
            operation: 'videoEdit',
            sourceVideo: video.url,
            referenceImages,
            audioSetting,
          }) as HappyHorseV1VideoEditInput,
        },
      ];
    }

    // img2vid:ref2vid
    if (data.workflow === 'img2vid:ref2vid') {
      const images = data.images?.map((x) => x.url) ?? [];
      if (images.length < 1)
        throw new Error('At least one reference image is required for img2vid:ref2vid');
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...base,
            operation: 'referenceToVideo',
            images,
            aspectRatio: data.aspectRatio
              ?.value as HappyHorseV1ReferenceToVideoInput['aspectRatio'],
          }) as HappyHorseV1ReferenceToVideoInput,
        },
      ];
    }

    // img2vid
    if (data.workflow === 'img2vid') {
      const image = data.images?.[0]?.url;
      if (!image) throw new Error('A source image is required for img2vid');
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...base,
            operation: 'imageToVideo',
            image,
          }) as HappyHorseV1ImageToVideoInput,
        },
      ];
    }

    // txt2vid (default)
    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          ...base,
          operation: 'textToVideo',
          aspectRatio: data.aspectRatio?.value as HappyHorseV1TextToVideoInput['aspectRatio'],
        }) as HappyHorseV1TextToVideoInput,
      },
    ];
  }
);
