/**
 * Hunyuan Ecosystem Handler
 *
 * Handles Hunyuan (HyV1) video generation workflows using videoGen step type.
 * Supports txt2vid workflow only (no img2vid support).
 * Supports LoRAs for customization.
 */

import type { HunyuanVdeoGenInput } from '@civitai/client';
import { getEcosystemName } from '~/shared/constants/basemodel.constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type HunyuanCtx = EcosystemGraphOutput & { baseModel: 'HyV1' };

/**
 * Converts a ResourceData object to a lora resource for Hunyuan.
 */
function resourceToLora(resource: ResourceData) {
  const ecosystem = getEcosystemName(resource.baseModel);
  const type = resource.model.type.toLowerCase();
  const air = `urn:air:${ecosystem}:${type}:civitai:${resource.model.id}@${resource.id}`;
  return { air, strength: resource.strength ?? 1 };
}

/**
 * Creates videoGen input for Hunyuan ecosystem.
 * Txt2vid only with CFG scale, steps, duration, and LoRA support.
 */
export async function createHunyuanInput(data: HunyuanCtx): Promise<HunyuanVdeoGenInput> {
  // Build loras from additional resources
  const loras: { air: string; strength: number }[] = [];
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras.push(resourceToLora(resource));
    }
  }

  return removeEmpty({
    engine: 'hunyuan',
    prompt: data.prompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
    steps: 'steps' in data ? data.steps : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    seed: data.seed,
    loras: loras.length > 0 ? loras : undefined,
  }) as HunyuanVdeoGenInput;
}
