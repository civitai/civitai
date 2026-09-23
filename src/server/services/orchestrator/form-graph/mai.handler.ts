/** MAI handler for the form-graph lane — one fal-engine imageGen step. */

import type {
  ImageGenStepTemplate,
  MaiImageCreateFalImageGenInput,
  MaiImageEditFalImageGenInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { maiCropAspectRatios } from '~/shared/form-graph/generation/image/mai.graph';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

type MAIAspectRatio = NonNullable<MaiImageCreateFalImageGenInput['aspectRatio']>;

export const createMAIInput = defineHandler<EcosystemData<'MAI'>, [ImageGenStepTemplate]>(
  (data) => {
    const baseInput = {
      engine: 'fal' as const,
      model: 'maiImage' as const,
      prompt: data.prompt,
      quantity: data.quantity ?? 1,
    };

    if (!(data.workflow ?? '').startsWith('txt')) {
      const firstImage = data.images?.[0];
      const aspectRatio =
        firstImage?.width && firstImage?.height
          ? (findClosestAspectRatio(
              { width: firstImage.width, height: firstImage.height },
              maiCropAspectRatios
            ) as MAIAspectRatio)
          : undefined;

      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            ...baseInput,
            operation: 'editImage',
            aspectRatio,
            images: data.images?.map((x) => x.url) ?? [],
          }) as MaiImageEditFalImageGenInput,
        },
      ];
    }

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          operation: 'createImage',
          aspectRatio: data.aspectRatio?.value as MAIAspectRatio | undefined,
        }) as MaiImageCreateFalImageGenInput,
      },
    ];
  }
);
