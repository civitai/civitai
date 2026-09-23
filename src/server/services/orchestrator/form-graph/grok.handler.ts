/**
 * Grok handlers for the form-graph lane — imageGen (v1/v2) and videoGen
 * (v1.0 edit/i2v/t2v, v1.5 ref2vid/i2v/t2v), routed on the workflow's output.
 */

import type {
  GrokCreateImageGenInput,
  GrokEditImageGenInput,
  GrokEditVideoInput,
  GrokImageToVideoInput,
  GrokTextToVideoInput,
  GrokV15ImageToVideoInput,
  GrokV15ReferenceToVideoInput,
  GrokV15TextToVideoInput,
  GrokV2CreateImageGenInput,
  GrokV2EditImageGenInput,
  ImageGenStepTemplate,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { isGrokV15, isGrokV2 } from '~/shared/form-graph/generation/grok-shared';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

const grokVideoAspectRatioList: GenerationAspectRatio[] = [
  '16:9',
  '3:2',
  '4:3',
  '1:1',
  '3:4',
  '2:3',
  '9:16',
];

export const createGrokImageInput = defineHandler<EcosystemData<'Grok'>, [ImageGenStepTemplate]>(
  (data) => {
    const hasImages = !!data.images?.length;

    const baseData = {
      engine: 'grok',
      prompt: data.prompt,
      quantity: data.quantity ?? 1,
      aspectRatio: data.aspectRatio?.value,
    };

    if (isGrokV2(data.model?.id)) {
      const v2Base = {
        ...baseData,
        version: 'v2.0' as const,
        resolution: 'quality' in data ? data.resolution : undefined,
        quality: 'quality' in data ? data.quality : undefined,
      };

      return [
        {
          $type: 'imageGen',
          input: removeEmpty(
            hasImages
              ? { ...v2Base, operation: 'editImage', images: data.images!.map((x) => x.url) }
              : { ...v2Base, operation: 'createImage' }
          ) as GrokV2CreateImageGenInput | GrokV2EditImageGenInput,
        },
      ];
    }

    const v1Base = { ...baseData, version: 'v1.0' as const };

    return [
      {
        $type: 'imageGen',
        input: removeEmpty(
          hasImages
            ? { ...v1Base, operation: 'editImage', images: data.images!.map((x) => x.url) }
            : { ...v1Base, operation: 'createImage' }
        ) as GrokCreateImageGenInput | GrokEditImageGenInput,
      },
    ];
  }
);

export const createGrokVideoInput = defineHandler<EcosystemData<'Grok'>, [VideoGenStepTemplate]>(
  (data) => {
    const hasImages = !!data.images?.length;
    const resolution: string = data.resolution ?? '720p';

    const baseData = {
      engine: 'grok',
      prompt: data.prompt,
      duration: 'duration' in data ? data.duration : undefined,
      resolution,
    };

    if (isGrokV15(data.model?.id)) {
      const v15Base = { ...baseData, version: 'v1.5' as const };

      if (data.workflow === 'img2vid:ref2vid') {
        const images = data.images?.map((x) => x.url) ?? [];
        if (!images.length)
          throw new Error('At least one reference image is required for img2vid:ref2vid');
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...v15Base,
              operation: 'referenceToVideo',
              images,
              aspectRatio: data.aspectRatio?.value as GrokV15ReferenceToVideoInput['aspectRatio'],
            }) as GrokV15ReferenceToVideoInput,
          },
        ];
      }

      if (hasImages) {
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...v15Base,
              operation: 'imageToVideo',
              images: [data.images![0].url] as [string],
            }) as GrokV15ImageToVideoInput,
          },
        ];
      }

      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...v15Base,
            operation: 'textToVideo',
            aspectRatio: data.aspectRatio?.value as GrokV15TextToVideoInput['aspectRatio'],
          }) as GrokV15TextToVideoInput,
        },
      ];
    }

    const v1Base = { ...baseData, version: 'v1.0' as const };

    if ('video' in data && data.video) {
      const video = data.video;
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...v1Base,
            operation: 'edit-video',
            videoUrl: video.url,
            analyzedDuration: video.metadata?.duration,
          }) as GrokEditVideoInput,
        },
      ];
    }

    if (hasImages) {
      const ratioEntries = getAspectRatioOptions(
        (resolution as '480p' | '720p') ?? '720p',
        grokVideoAspectRatioList
      );
      const aspectRatio = findClosestAspectRatio(data.images![0], ratioEntries);
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...v1Base,
            operation: 'image-to-video',
            aspectRatio: aspectRatio?.value as GrokImageToVideoInput['aspectRatio'],
            images: [data.images![0].url] as [string],
          }) as GrokImageToVideoInput,
        },
      ];
    }

    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          ...v1Base,
          operation: 'text-to-video',
          aspectRatio: data.aspectRatio?.value as GrokTextToVideoInput['aspectRatio'],
        }) as GrokTextToVideoInput,
      },
    ];
  }
);
