/** Pony V7 handler for the form-graph lane — Euler-fixed. */

import type {
  ImageGenStepTemplate,
  ImageJobNetworkParams,
  Scheduler,
  TextToImageStepTemplate,
} from '@civitai/client';
import type { ComfyPonyV7CreateImageGenInput } from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import {
  samplersToComfySamplers,
  samplersToSchedulers,
} from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras, type EcosystemData } from './types';

export const createPonyV7Input = defineHandler<
  EcosystemData<'PonyV7'>,
  [TextToImageStepTemplate | ImageGenStepTemplate]
>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for PonyV7 workflows');

  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  if (ctx.useImageGen) {
    if (!data.model) throw new Error('Model is required for PonyV7 imageGen workflows');

    const input: ComfyPonyV7CreateImageGenInput = {
      engine: 'comfy',
      ecosystem: 'ponyV7',
      operation: 'createImage',
      model: ctx.airs.getOrThrow(data.model.id),
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      steps: data.steps ?? 25,
      cfgScale: data.cfgScale ?? 7,
      sampler: samplersToComfySamplers['Euler'].sampler,
      seed,
      quantity,
      outputFormat: data.outputFormat,
      loras: resourcesToLoras(data.resources, ctx.airs),
    };

    return [{ $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate];
  }

  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  for (const resource of data.resources ?? []) {
    additionalNetworks[ctx.airs.getOrThrow(resource.id)] = { strength: resource.strength };
  }

  return [
    {
      $type: 'textToImage',
      input: {
        model: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
        additionalNetworks,
        scheduler: samplersToSchedulers['Euler'] as Scheduler,
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
});
