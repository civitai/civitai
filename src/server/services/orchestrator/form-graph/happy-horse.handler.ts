/** HappyHorse handler for the form-graph lane — v1.0/v1.1 op families. */

import type {
  HappyHorseV1ImageToVideoInput,
  HappyHorseV1ReferenceToVideoInput,
  HappyHorseV1TextToVideoInput,
  HappyHorseV1VideoEditInput,
  HappyHorseV11ImageToVideoInput,
  HappyHorseV11ReferenceToVideoInput,
  HappyHorseV11TextToVideoInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { happyHorseVersionIds } from '~/shared/data-graph/generation/version-ids';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

const ENGINE = 'happyHorse' as const;

type HappyHorseVersion = keyof typeof happyHorseVersionIds;

const versionIdToVersion = new Map<number, HappyHorseVersion>(
  Object.entries(happyHorseVersionIds).map(([version, id]) => [id, version as HappyHorseVersion])
);

export const createHappyHorseInput = defineHandler<LooseGenerationData, [VideoGenStepTemplate]>(
  (data) => {
    const version: HappyHorseVersion =
      (data.model ? versionIdToVersion.get(data.model.id) : undefined) ?? 'v1.0';

    const base = {
      engine: ENGINE,
      version,
      prompt: data.prompt,
      resolution: (data as { resolution?: HappyHorseV1TextToVideoInput['resolution'] }).resolution,
      duration: (data as { duration?: number }).duration,
      seed: data.seed,
    };

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

    if (data.workflow === 'vid2vid:edit') {
      const video = data.video as { url?: string } | undefined;
      if (!video?.url) throw new Error('A source video is required for vid2vid:edit');
      const referenceImages = data.images?.length ? data.images.map((x) => x.url) : undefined;
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...base,
            operation: 'videoEdit',
            sourceVideo: video.url,
            referenceImages,
            audioSetting: (data as { audioSetting?: HappyHorseV1VideoEditInput['audioSetting'] })
              .audioSetting,
          }) as HappyHorseV1VideoEditInput,
        },
      ];
    }

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
