/** Mochi handler for the form-graph lane — one mochi-engine videoGen step. */

import type { MochiVideoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

export const createMochiInput = defineHandler<EcosystemData<'Mochi'>, [VideoGenStepTemplate]>(
  (data) => [
    {
      $type: 'videoGen',
      input: removeEmpty({
        engine: 'mochi',
        prompt: data.prompt,
        quantity: data.quantity ?? 1,
        seed: data.seed,
        enablePromptEnhancer: data.enablePromptEnhancer,
      }) as MochiVideoGenInput,
    },
  ]
);
