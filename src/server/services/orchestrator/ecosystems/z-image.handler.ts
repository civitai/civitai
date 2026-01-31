/**
 * ZImage Ecosystem Handler
 *
 * Handles ZImageTurbo and ZImageBase workflows using textToImage step type.
 * Fast generation, no negative prompt support.
 */

import type { ImageJobNetworkParams, Scheduler, TextToImageStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type ZImageCtx = EcosystemGraphOutput & { baseModel: 'ZImageTurbo' | 'ZImageBase' };

/**
 * Creates step input for ZImage ecosystems (ZImageTurbo and ZImageBase).
 * Fast generation with no negative prompt support.
 */
export const createZImageInput = defineHandler<ZImageCtx, TextToImageStepTemplate>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for ZImage workflows');

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
      // No negative prompt for ZImageTurbo
      steps: data.steps ?? 4,
      cfgScale: data.cfgScale ?? 1,
      seed,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      quantity,
      batchSize: 1,
      outputFormat: data.outputFormat,
    },
  } as TextToImageStepTemplate;
});
