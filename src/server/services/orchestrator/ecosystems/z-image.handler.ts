/**
 * ZImage Ecosystem Handler
 *
 * Handles ZImageTurbo and ZImageBase workflows using imageGen step type.
 * Uses SdCpp samplers (euler, heun) and schedulers (simple, discrete).
 * Supports LoRA resources.
 */

import type {
  ZImageTurboCreateImageGenInput,
  ZImageBaseCreateImageGenInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type ZImageCtx = EcosystemGraphOutput & { ecosystem: 'ZImageTurbo' | 'ZImageBase' };

// Return type union
type ZImageInput = ZImageTurboCreateImageGenInput | ZImageBaseCreateImageGenInput;

// Map baseModel to model variant
const baseModelToModel: Record<string, 'turbo' | 'base'> = {
  ZImageTurbo: 'turbo',
  ZImageBase: 'base',
};

/**
 * Creates imageGen input for ZImage ecosystems (ZImageTurbo and ZImageBase).
 * Uses SdCpp samplers/schedulers. Supports LoRA resources.
 */
export const createZImageInput = defineHandler<ZImageCtx, ZImageInput>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for ZImage workflows');

  const quantity = data.quantity ?? 1;
  const model = baseModelToModel[data.ecosystem] ?? 'turbo';

  // Build loras from additional resources
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }

  return removeEmpty({
    engine: 'sdcpp',
    ecosystem: 'zImage',
    model,
    operation: 'createImage' as const,
    prompt: data.prompt,
    negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
    width: data.aspectRatio.width,
    height: data.aspectRatio.height,
    cfgScale: data.cfgScale ?? 1,
    steps: data.steps ?? 4,
    sampleMethod: 'sampler' in data ? data.sampler : 'euler',
    schedule: 'scheduler' in data ? data.scheduler : 'simple',
    quantity,
    seed: data.seed,
    loras: Object.keys(loras).length > 0 ? loras : undefined,
  }) as ZImageInput;
});
