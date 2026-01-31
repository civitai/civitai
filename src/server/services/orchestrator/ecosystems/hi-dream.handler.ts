/**
 * HiDream Ecosystem Handler
 *
 * Handles HiDream workflows using textToImage step type.
 * Uses HiDream-specific input transformation for variant handling.
 */

import type { ImageJobNetworkParams, Scheduler, TextToImageStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getHiDreamInput } from '~/shared/orchestrator/hidream.config';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type HiDreamCtx = EcosystemGraphOutput & { baseModel: 'HiDream' };

/**
 * Creates step input for HiDream ecosystem.
 * Uses HiDream-specific input transformation for variant handling.
 */
export const createHiDreamInput = defineHandler<HiDreamCtx, TextToImageStepTemplate>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for HiDream workflows');
    if (!data.model) throw new Error('Model is required for HiDream workflows');

    const quantity = data.quantity ?? 1;
    const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

    // Use HiDream-specific input transformation
    const hiDreamResult = getHiDreamInput({
      baseModel: 'HiDream',
      workflow: data.workflow,
      resources: [
        {
          id: data.model.id,
          strength: ('strength' in data.model ? data.model.strength : undefined) ?? 1,
        },
        ...('resources' in data && data.resources
          ? data.resources.map((r) => ({ id: r.id, strength: r.strength ?? 1 }))
          : []),
      ],
      prompt: data.prompt,
      negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      seed,
      steps: 'steps' in data ? data.steps : undefined,
      cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
      sampler: 'sampler' in data ? data.sampler : undefined,
    });

    // Build additionalNetworks from transformed resources
    const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
    for (const resource of hiDreamResult.resources ?? []) {
      if (resource.air) {
        additionalNetworks[resource.air] = {
          strength: resource.strength,
          type: 'LORA',
        };
      }
    }

    const { params } = hiDreamResult;
    const scheduler = samplersToSchedulers[
      (params.sampler ?? 'Euler') as keyof typeof samplersToSchedulers
    ] as Scheduler;

    return {
      $type: 'textToImage',
      input: {
        model: ctx.airs.getOrThrow(data.model.id),
        additionalNetworks,
        scheduler,
        prompt: params.prompt ?? data.prompt,
        negativePrompt:
          params.negativePrompt ?? ('negativePrompt' in data ? data.negativePrompt : undefined),
        steps: params.steps ?? ('steps' in data ? data.steps : undefined) ?? 25,
        cfgScale: params.cfgScale ?? ('cfgScale' in data ? data.cfgScale : undefined) ?? 7,
        clipSkip: 'clipSkip' in data ? data.clipSkip : undefined,
        seed,
        width: params.width ?? data.aspectRatio.width,
        height: params.height ?? data.aspectRatio.height,
        quantity,
        batchSize: 1,
        outputFormat: 'outputFormat' in data ? data.outputFormat : undefined,
      },
    } as TextToImageStepTemplate;
  }
);
