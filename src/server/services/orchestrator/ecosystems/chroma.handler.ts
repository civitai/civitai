/**
 * Chroma Ecosystem Handler
 *
 * Handles Chroma workflows using textToImage step type.
 * Chroma uses a fixed Euler sampler internally.
 */

import type { ImageJobNetworkParams, Scheduler, TextToImageStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type ChromaCtx = EcosystemGraphOutput & { ecosystem: 'Chroma' };

/**
 * Creates step input for Chroma ecosystem.
 * Chroma uses a fixed Euler sampler internally.
 */
export const createChromaInput = defineHandler<ChromaCtx, TextToImageStepTemplate>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for Chroma workflows');

  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  // Build additionalNetworks from resources
  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  for (const resource of data.resources ?? []) {
    additionalNetworks[ctx.airs.getOrThrow(resource.id)] = { strength: resource.strength };
  }

  return {
    $type: 'textToImage',
    input: {
      model: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
      additionalNetworks,
      scheduler: 'euler' as Scheduler,
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
  } as TextToImageStepTemplate;
});
