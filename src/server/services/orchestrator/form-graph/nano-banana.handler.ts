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
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

export const createNanoBananaInput = defineHandler<
  EcosystemData<'NanoBanana'>,
  [ImageGenStepTemplate]
>((data) => {
  const quantity = data.quantity ?? 1;

  if (data.nanoBananaMode === 'standard') {
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

  if (data.nanoBananaMode === 'v2') {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'google',
          model: 'nano-banana-2',
          prompt: data.prompt,
          aspectRatio: data.aspectRatio?.value,
          resolution: data.resolution,
          images: data.images?.map((x) => x.url),
          numImages: quantity,
          seed: data.seed,
          enableWebSearch: data.enableWebSearch,
        }) as NanoBanana2ImageGenInput,
      },
    ];
  }

  if (data.nanoBananaMode === 'v2lite') {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'google',
          model: 'nano-banana-2-lite',
          prompt: data.prompt,
          aspectRatio: data.aspectRatio?.value,
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
        width: data.aspectRatio?.width,
        height: data.aspectRatio?.height,
        aspectRatio: data.aspectRatio?.value,
        resolution: data.resolution,
        outputFormat: data.outputFormat,
        images: data.images?.map((x) => x.url),
        numImages: quantity,
        seed: data.seed,
      }) as NanoBananaProImageGenInput,
    },
  ];
});
