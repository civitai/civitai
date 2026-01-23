/**
 * Chroma Ecosystem Handler
 *
 * Handles Chroma workflows using textToImage step type.
 * Chroma uses a fixed Euler sampler internally.
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
type ChromaCtx = EcosystemGraphOutput & { baseModel: 'Chroma' };

/**
 * Converts a ResourceData object to an AIR string.
 */
function resourceToAir(resource: ResourceData): string {
  const ecosystem = getEcosystemName(resource.baseModel);
  const type = resource.model.type.toLowerCase();
  return `urn:air:${ecosystem}:${type}:civitai:${resource.model.id}@${resource.id}`;
}

/**
 * Creates step input for Chroma ecosystem.
 * Chroma uses a fixed Euler sampler internally.
 */
export async function createChromaInput(data: ChromaCtx): Promise<StepInput> {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for Chroma workflows');

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
      steps: data.steps ?? 28,
      cfgScale: data.cfgScale ?? 3.5,
      seed,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      quantity,
      batchSize: 1,
      outputFormat: data.outputFormat,
    },
  } as StepInput;
}
