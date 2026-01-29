/**
 * Hunyuan Ecosystem Handler
 *
 * Handles Hunyuan (HyV1) video generation workflows using videoGen step type.
 * Supports txt2vid workflow only (no img2vid support).
 * Supports LoRAs for customization.
 */

import type { HunyuanVdeoGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type HunyuanCtx = EcosystemGraphOutput & { baseModel: 'HyV1' };

/**
 * Creates videoGen input for Hunyuan ecosystem.
 * Txt2vid only with CFG scale, steps, duration, and LoRA support.
 */
export const createHunyuanInput = defineHandler<HunyuanCtx, HunyuanVdeoGenInput>((data, ctx) => {
  // Build loras from additional resources
  const loras: { air: string; strength: number }[] = [];
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras.push({
        air: ctx.airs.getOrThrow(resource.id),
        strength: resource.strength ?? 1,
      });
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
});
