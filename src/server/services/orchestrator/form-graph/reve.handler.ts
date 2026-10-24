/** Reve handler for the form-graph lane — one fal-engine imageGen step. */

import type {
  ImageGenStepTemplate,
  ReveCreateFalImageGenInput,
  ReveEditFalImageGenInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

type ReveAspectRatio = NonNullable<ReveCreateFalImageGenInput['aspectRatio']>;

export const createReveInput = defineHandler<EcosystemData<'Reve'>, [ImageGenStepTemplate]>(
  (data) => {
    const baseInput = {
      engine: 'fal' as const,
      model: 'reve' as const,
      prompt: data.prompt,
      quantity: data.quantity ?? 1,
    };

    if (!(data.workflow ?? '').startsWith('txt')) {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty<ReveEditFalImageGenInput>({
            ...baseInput,
            operation: 'editImage',
            aspectRatio: 'auto',
            images: data.images?.map((x) => x.url) ?? [],
          }),
        },
      ];
    }

    return [
      {
        $type: 'imageGen',
        input: removeEmpty<ReveCreateFalImageGenInput>({
          ...baseInput,
          operation: 'createImage',
          aspectRatio: data.aspectRatio?.value as ReveAspectRatio | undefined,
        }),
      },
    ];
  }
);
