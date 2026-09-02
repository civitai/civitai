/** Sora 2 handler for the form-graph lane — text/image-to-video. */

import type {
  Sora2ImageToVideoInput,
  Sora2TextToVideoInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

type SoraInput = Sora2TextToVideoInput | Sora2ImageToVideoInput;

export const createSoraInput = defineHandler<LooseGenerationData, [VideoGenStepTemplate]>(
  (data) => {
    const hasImages = !!data.images?.length;

    const baseInput = {
      engine: 'sora',
      prompt: data.prompt,
      aspectRatio: data.aspectRatio?.value as SoraInput['aspectRatio'],
      resolution: (data as { resolution?: string }).resolution,
      usePro: (data as { usePro?: boolean }).usePro,
      duration: (data as { duration?: number }).duration,
      quantity: data.quantity ?? 1,
      seed: data.seed,
      operation: 'text-to-video',
    };

    if (hasImages) {
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...baseInput,
            images: data.images?.map((x) => x.url),
            operation: 'image-to-video',
          }) as Sora2ImageToVideoInput,
        },
      ];
    }
    return [{ $type: 'videoGen', input: removeEmpty(baseInput) as Sora2TextToVideoInput }];
  }
);
