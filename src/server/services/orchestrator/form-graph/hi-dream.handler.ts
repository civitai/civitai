/** HiDream handler for the form-graph lane — textToImage through hidream.config. */

import type { ImageJobNetworkParams, Scheduler, TextToImageStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getHiDreamInput } from '~/shared/orchestrator/hidream.config';
import { getRandomInt } from '~/utils/number-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

export const createHiDreamInput = defineHandler<LooseGenerationData, [TextToImageStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for HiDream workflows');
    if (!data.model) throw new Error('Model is required for HiDream workflows');

    const quantity = data.quantity ?? 1;
    const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

    const hiDreamResult = getHiDreamInput({
      ecosystem: 'HiDream',
      workflow: data.workflow ?? '',
      resources: [
        { id: data.model.id, strength: data.model.strength ?? 1 },
        ...(data.resources ?? []).map((r) => ({ id: r.id, strength: r.strength ?? 1 })),
      ],
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      seed,
      steps: data.steps,
      cfgScale: data.cfgScale,
      sampler: data.sampler,
    });

    const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
    for (const resource of hiDreamResult.resources ?? []) {
      if (resource.air) {
        additionalNetworks[resource.air] = { strength: resource.strength, type: 'LORA' };
      }
    }

    const { params } = hiDreamResult;
    const scheduler = samplersToSchedulers[
      (params.sampler ?? 'Euler') as keyof typeof samplersToSchedulers
    ] as Scheduler;

    return [
      {
        $type: 'textToImage',
        input: {
          model: ctx.airs.getOrThrow(data.model.id),
          additionalNetworks,
          scheduler,
          prompt: params.prompt ?? data.prompt,
          negativePrompt: params.negativePrompt ?? data.negativePrompt,
          steps: params.steps ?? data.steps ?? 25,
          cfgScale: params.cfgScale ?? data.cfgScale ?? 7,
          clipSkip: data.clipSkip,
          seed,
          width: params.width ?? data.aspectRatio.width,
          height: params.height ?? data.aspectRatio.height,
          quantity,
          batchSize: 1,
          outputFormat: data.outputFormat,
        },
      } as TextToImageStepTemplate,
    ];
  }
);
