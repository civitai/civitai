/** Flux.3 handler for the form-graph lane — one fal-engine imageGen step. */

import type { ImageGenStepTemplate } from '@civitai/client';
import type {
  Flux3CreateFalImageGenInput,
  Flux3EditFalImageGenInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

type Flux3AspectRatio = NonNullable<Flux3CreateFalImageGenInput['aspectRatio']>;

export const createFlux3Input = defineHandler<EcosystemData<'Flux3'>, [ImageGenStepTemplate]>(
  (data) => {
    const baseInput = {
      engine: 'fal' as const,
      model: 'flux3' as const,
      prompt: data.prompt ?? '',
      quantity: data.quantity ?? 1,
      resolution: data.resolution,
      enablePromptExpansion: data.enablePromptExpansion,
    };

    if (!(data.workflow ?? '').startsWith('txt')) {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            ...baseInput,
            operation: 'editImage',
            aspectRatio: 'auto', // output follows the first reference
            images: data.images?.map((x) => x.url) ?? [],
          }) as Flux3EditFalImageGenInput,
        },
      ];
    }

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          operation: 'createImage',
          aspectRatio: data.aspectRatio?.value as Flux3AspectRatio | undefined,
        }) as Flux3CreateFalImageGenInput,
      },
    ];
  }
);
