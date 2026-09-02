/**
 * Chroma handler for the form-graph lane — textToImage steps.
 */

import type { ImageJobNetworkParams, Scheduler, TextToImageStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getRandomInt } from '~/utils/number-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

export const createChromaInput = defineHandler<LooseGenerationData, [TextToImageStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for Chroma workflows');

    const quantity = data.quantity ?? 1;
    const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

    const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
    for (const resource of data.resources ?? []) {
      additionalNetworks[ctx.airs.getOrThrow(resource.id)] = { strength: resource.strength };
    }

    const sampler = data.sampler ?? 'Euler';
    const scheduler =
      (samplersToSchedulers[sampler as keyof typeof samplersToSchedulers] as Scheduler) ??
      ('euler' as Scheduler);

    return [
      {
        $type: 'textToImage',
        input: {
          model: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
          additionalNetworks,
          scheduler,
          prompt: data.prompt,
          steps: data.steps ?? 28,
          cfgScale: data.cfgScale ?? 3.5,
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
