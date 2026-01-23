/**
 * ZImageTurbo Ecosystem Handler
 *
 * Handles ZImageTurbo workflows using textToImage step type.
 * Fast generation, no negative prompt support.
 */

import type { ImageJobNetworkParams, Scheduler, WorkflowStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { getEcosystemName } from '~/shared/constants/basemodel.constants';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type StepInput = WorkflowStepTemplate & { input: unknown };
type ZImageTurboCtx = EcosystemGraphOutput & { baseModel: 'ZImageTurbo' };

/**
 * Converts a ResourceData object to an AIR string.
 */
function resourceToAir(resource: ResourceData): string {
  const ecosystem = getEcosystemName(resource.baseModel);
  const type = resource.model.type.toLowerCase();
  return `urn:air:${ecosystem}:${type}:civitai:${resource.model.id}@${resource.id}`;
}

/**
 * Creates step input for ZImageTurbo ecosystem.
 * Fast generation with no negative prompt support.
 */
export async function createZImageTurboInput(data: ZImageTurboCtx): Promise<StepInput> {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for ZImageTurbo workflows');

  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  // Build additionalNetworks from resources
  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  for (const resource of data.resources ?? []) {
    additionalNetworks[resourceToAir(resource)] = {
      strength: resource.strength,
      type: resource.model.type,
    };
  }

  return {
    $type: 'textToImage',
    input: {
      model: data.model ? resourceToAir(data.model) : undefined,
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
  } as StepInput;
}
