/** Nano Banana handler for the form-graph lane — gemini/google engines by mode. */

import type {
  Gemini25FlashCreateImageGenInput,
  Gemini25FlashEditImageGenInput,
  ImageGenStepTemplate,
  NanoBanana2ImageGenInput,
  NanoBanana2LiteImageGenInput,
  NanoBananaProImageGenInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import {
  nanoBananaModeOf,
  type NanoBananaMode,
} from '~/shared/form-graph/generation/image/nano-banana.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

export const createNanoBananaInput = defineHandler<LooseGenerationData, [ImageGenStepTemplate]>(
  (data) => {
    const model: NanoBananaMode = nanoBananaModeOf(data.model);

    const quantity = data.quantity ?? 1;
    const aspectRatio = data.aspectRatio;
    const resolution = (data as { resolution?: string }).resolution;

    if (model === 'standard') {
      const hasImages = !!data.images?.length;
      return [
        {
          $type: 'imageGen',
          input: removeEmpty(
            hasImages
              ? {
                  engine: 'gemini',
                  model: '2.5-flash',
                  operation: 'editImage',
                  prompt: data.prompt,
                  quantity,
                  images: data.images?.map((x) => x.url) ?? [],
                  seed: data.seed,
                }
              : {
                  engine: 'gemini',
                  model: '2.5-flash',
                  operation: 'createImage',
                  prompt: data.prompt,
                  quantity,
                  seed: data.seed,
                }
          ) as Gemini25FlashCreateImageGenInput | Gemini25FlashEditImageGenInput,
        },
      ];
    }

    if (model === 'v2') {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            engine: 'google',
            model: 'nano-banana-2',
            prompt: data.prompt,
            aspectRatio: aspectRatio?.value,
            resolution,
            images: data.images?.map((x) => x.url),
            numImages: quantity,
            seed: data.seed,
            enableWebSearch: (data as { enableWebSearch?: boolean }).enableWebSearch,
          }) as NanoBanana2ImageGenInput,
        },
      ];
    }

    if (model === 'v2lite') {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            engine: 'google',
            model: 'nano-banana-2-lite',
            prompt: data.prompt,
            aspectRatio: aspectRatio?.value,
            images: data.images?.map((x) => x.url),
            numImages: quantity,
            seed: data.seed,
          }) as NanoBanana2LiteImageGenInput,
        },
      ];
    }

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'google',
          model: 'nano-banana-pro',
          prompt: data.prompt,
          negativePrompt: undefined,
          width: aspectRatio?.width,
          height: aspectRatio?.height,
          aspectRatio: aspectRatio?.value,
          resolution,
          outputFormat: data.outputFormat,
          images: data.images?.map((x) => x.url),
          numImages: quantity,
          seed: data.seed,
        }) as NanoBananaProImageGenInput,
      },
    ];
  }
);
