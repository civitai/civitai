/** Pony V7 handler for the form-graph lane — a textToImage step, Euler-fixed. */

import type { ImageJobNetworkParams, Scheduler, TextToImageStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getRandomInt } from '~/utils/number-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

export const createPonyV7Input = defineHandler<LooseGenerationData, [TextToImageStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for PonyV7 workflows');

    const quantity = data.quantity ?? 1;
    const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

    const allResources = [...(data.resources ?? []), ...(data.vae ? [data.vae] : [])];
    const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
    for (const resource of allResources) {
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
          clipSkip: data.clipSkip,
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
