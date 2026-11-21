/** MAI handler for the form-graph lane — one fal-engine imageGen step. */

import type {
  ImageGenStepTemplate,
  MaiImage27CreateFalImageGenInput,
  MaiImage27EditFalImageGenInput,
  MaiImageCreateFalImageGenInput,
  MaiImageEditFalImageGenInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import {
  isMai27,
  maiCropAspectRatios,
  maiVersionIds,
} from '~/shared/form-graph/generation/image/mai.graph';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

type MAIAspectRatio = NonNullable<MaiImageCreateFalImageGenInput['aspectRatio']>;

export const createMAIInput = defineHandler<EcosystemData<'MAI'>, [ImageGenStepTemplate]>(
  (data) => {
    const isEdit = !(data.workflow ?? '').startsWith('txt');

    if (isMai27(data.model?.id)) {
      const base = {
        engine: 'fal' as const,
        model: 'maiImage27' as const,
        variant:
          data.model?.id === maiVersionIds['2.7-flash']
            ? ('flash' as const)
            : ('standard' as const),
        prompt: data.prompt,
        quantity: data.quantity ?? 1,
        resolution: data.resolution as '1K' | '2K' | undefined,
      };

      return [
        {
          $type: 'imageGen',
          input: isEdit
            ? removeEmpty<MaiImage27EditFalImageGenInput>({
                ...base,
                operation: 'editImage',
                images: data.images?.map((x) => x.url) ?? [],
              })
            : removeEmpty<MaiImage27CreateFalImageGenInput>({
                ...base,
                operation: 'createImage',
                width: data.aspectRatio?.width,
                height: data.aspectRatio?.height,
              }),
        },
      ];
    }

    const baseInput = {
      engine: 'fal' as const,
      model: 'maiImage' as const,
      prompt: data.prompt,
      quantity: data.quantity ?? 1,
    };

    if (isEdit) {
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
          input: removeEmpty<MaiImageEditFalImageGenInput>({
            ...baseInput,
            operation: 'editImage',
            aspectRatio,
            images: data.images?.map((x) => x.url) ?? [],
          }),
        },
      ];
    }

    return [
      {
        $type: 'imageGen',
        input: removeEmpty<MaiImageCreateFalImageGenInput>({
          ...baseInput,
          operation: 'createImage',
          aspectRatio: data.aspectRatio?.value as MAIAspectRatio | undefined,
        }),
      },
    ];
  }
);
