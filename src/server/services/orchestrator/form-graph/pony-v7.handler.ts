/** Pony V7 handler for the form-graph lane — a textToImage step, Euler-fixed. */

import type { ImageJobNetworkParams, Scheduler, TextToImageStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getRandomInt } from '~/utils/number-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

export const createPonyV7Input = defineHandler<EcosystemData<'PonyV7'>, [TextToImageStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for PonyV7 workflows');

    const quantity = data.quantity ?? 1;
    const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

    const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
    for (const resource of data.resources ?? []) {
      additionalNetworks[ctx.airs.getOrThrow(resource.id)] = { strength: resource.strength };
    }

    const scheduler = samplersToSchedulers['Euler'] as Scheduler;

    return [
      {
        $type: 'textToImage',
        input: {
          model: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
          additionalNetworks,
          scheduler,
          prompt: data.prompt,
          negativePrompt: data.negativePrompt,
          steps: data.steps ?? 25,
          cfgScale: data.cfgScale ?? 7,
          seed,
          width: data.aspectRatio.width,
          height: data.aspectRatio.height,
          quantity,
          batchSize: 1,
          outputFormat: data.outputFormat,
        },
      } as TextToImageStepTemplate,
    ];
  }
);
