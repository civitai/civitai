/** Muse Image handler for the form-graph lane — one fal-engine imageGen step. */

import type {
  ImageGenStepTemplate,
  MuseImageCreateFalImageGenInput,
  MuseImageEditFalImageGenInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

type MuseImageAspectRatio = NonNullable<MuseImageCreateFalImageGenInput['aspectRatio']>;

export const createMuseImageInput = defineHandler<
  EcosystemData<'MuseImage'>,
  [ImageGenStepTemplate]
>((data) => {
  const baseInput = {
    engine: 'fal' as const,
    model: 'museImage' as const,
    prompt: data.prompt,
    quantity: data.quantity ?? 1,
  };

  // img2img:edit — Muse Image derives the output ratio from the reference
  // images, so no aspect-ratio picker is shown ('auto').
  if (!(data.workflow ?? '').startsWith('txt')) {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          operation: 'editImage',
          aspectRatio: 'auto',
          images: data.images?.map((x) => x.url) ?? [],
        }) as MuseImageEditFalImageGenInput,
      },
    ];
  }

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        ...baseInput,
        operation: 'createImage',
        aspectRatio: data.aspectRatio?.value as MuseImageAspectRatio | undefined,
      }) as MuseImageCreateFalImageGenInput,
    },
  ];
});
