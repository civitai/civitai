/** Imagen 4 handler for the form-graph lane — one google-engine imageGen step. */

import type { Imagen4ImageGenInput, ImageGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

type Imagen4AspectRatio = '16:9' | '4:3' | '1:1' | '3:4' | '9:16';

export const createImagen4Input = defineHandler<LooseGenerationData, [ImageGenStepTemplate]>(
  (data) => [
    {
      $type: 'imageGen',
      input: removeEmpty({
        engine: 'google',
        model: 'imagen4',
        prompt: data.prompt,
        negativePrompt: data.negativePrompt,
        aspectRatio: data.aspectRatio?.value as Imagen4AspectRatio | undefined,
        numImages: data.quantity ?? 1,
        seed: data.seed,
      }) as Imagen4ImageGenInput,
    },
  ]
);
