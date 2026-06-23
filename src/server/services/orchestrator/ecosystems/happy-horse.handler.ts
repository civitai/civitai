/**
 * HappyHorse Ecosystem Handler
 *
 * Handles Alibaba Taotian HappyHorse video generation (FAL).
 * The selected model version id maps to the engine version:
 * - 2902378 → v1.0 (txt2vid / img2vid / ref2vid / vid2vid:edit)
 * - 3063263 → v1.1 (txt2vid / img2vid / ref2vid — no videoEdit)
 *
 * Operations are selected by workflow. v1.1 reuses the same operation shapes as
 * v1.0 minus videoEdit, so each version branch casts to its own client types.
 */

import type {
  HappyHorseV1TextToVideoInput,
  HappyHorseV1ImageToVideoInput,
  HappyHorseV1ReferenceToVideoInput,
  HappyHorseV1VideoEditInput,
  HappyHorseV11TextToVideoInput,
  HappyHorseV11ImageToVideoInput,
  HappyHorseV11ReferenceToVideoInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { happyHorseVersionIds } from '~/shared/data-graph/generation/version-ids';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type HappyHorseCtx = EcosystemGraphOutput & { ecosystem: 'HappyHorse' };

const ENGINE = 'happyHorse' as const;

type HappyHorseVersion = 'v1.0' | 'v1.1';

// Reverse map: model version id → engine version
const versionIdToVersion = new Map<number, HappyHorseVersion>(
  Object.entries(happyHorseVersionIds).map(([version, id]) => [id, version as HappyHorseVersion])
);

/**
 * Creates videoGen input for HappyHorse ecosystem.
 * Routes to the appropriate engine version + operation based on the selected
 * model version and workflow.
 */
export const createHappyHorseInput = defineHandler<HappyHorseCtx, [VideoGenStepTemplate]>(
  (data) => {
    const version: HappyHorseVersion =
      (data.model ? versionIdToVersion.get(data.model.id) : undefined) ?? 'v1.0';

    // enableSafetyChecker is in the type spec but intentionally not exposed —
    // matches peer video ecosystems and avoids double-filtering against Civitai's own NSFW pipeline.
    const base = {
      engine: ENGINE,
      version,
      prompt: data.prompt,
      resolution:
        'resolution' in data
          ? (data.resolution as HappyHorseV1TextToVideoInput['resolution'])
          : undefined,
      duration: 'duration' in data ? data.duration : undefined,
      seed: data.seed,
    };

    // ---------------------------------------------------------------------------
    // v1.1 — txt2vid / img2vid / img2vid:ref2vid (no videoEdit)
    // ---------------------------------------------------------------------------
    if (version === 'v1.1') {
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
                ?.value as HappyHorseV11ReferenceToVideoInput['aspectRatio'],
            }) as HappyHorseV11ReferenceToVideoInput,
          },
        ];
      }

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
            }) as HappyHorseV11ImageToVideoInput,
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
            aspectRatio: data.aspectRatio?.value as HappyHorseV11TextToVideoInput['aspectRatio'],
          }) as HappyHorseV11TextToVideoInput,
        },
      ];
    }

    // ---------------------------------------------------------------------------
    // v1.0 — txt2vid / img2vid / img2vid:ref2vid / vid2vid:edit
    // ---------------------------------------------------------------------------

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
