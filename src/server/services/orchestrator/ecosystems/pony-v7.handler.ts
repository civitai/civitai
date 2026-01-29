/**
 * PonyV7 Ecosystem Handler
 *
 * Handles PonyV7 workflows using textToImage step type.
 * Uses Euler sampler, no draft mode.
 */

import type { ImageJobNetworkParams, Scheduler, TextToImageStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type PonyV7Ctx = EcosystemGraphOutput & { baseModel: 'PonyV7' };

/**
 * Creates step input for PonyV7 ecosystem.
 * Uses Euler sampler, no draft mode.
 */
export const createPonyV7Input = defineHandler<PonyV7Ctx, TextToImageStepTemplate>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for PonyV7 workflows');

  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  // Build additionalNetworks from resources + vae
  const vae = 'vae' in data ? (data.vae as ResourceData | undefined) : undefined;
  const allResources = [...(data.resources ?? []), ...(vae ? [vae] : [])];
  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  for (const resource of allResources) {
    additionalNetworks[ctx.airs.getOrThrow(resource.id)] = { strength: resource.strength };
  }

  // PonyV7 always uses Euler sampler
  const scheduler = samplersToSchedulers['Euler'] as Scheduler;

  return {
    $type: 'textToImage',
    input: {
      model: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
      additionalNetworks,
      scheduler,
      prompt: data.prompt,
      negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
      steps: data.steps ?? 25,
      cfgScale: data.cfgScale ?? 7,
      clipSkip: 'clipSkip' in data ? data.clipSkip : undefined,
      seed,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      quantity,
      batchSize: 1,
      outputFormat: data.outputFormat,
    },
  } as TextToImageStepTemplate;
});
