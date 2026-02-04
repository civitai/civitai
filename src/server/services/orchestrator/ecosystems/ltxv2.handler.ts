/**
 * LTXV2 Ecosystem Handler
 *
 * Handles LTXV2 video generation workflows using videoGen step type.
 * Supports txt2vid workflow with LoRA support.
 */

import type { ComfyLtx2CreateVideoInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type LTXV2Ctx = EcosystemGraphOutput & { ecosystem: 'LTXV2' };

/**
 * Creates videoGen input for LTXV2 ecosystem.
 * Txt2vid with CFG scale, steps, duration, and LoRA support.
 */
export const createLTXV2Input = defineHandler<LTXV2Ctx, ComfyLtx2CreateVideoInput>((data, ctx) => {
  // Build loras from additional resources
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }

  return removeEmpty({
    engine: 'ltx2',
    operation: 'createVideo',
    prompt: data.prompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    guidanceScale: 'cfgScale' in data ? data.cfgScale : undefined,
    steps: 'steps' in data ? data.steps : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    seed: data.seed,
    loras: Object.keys(loras).length > 0 ? loras : undefined,
  }) as ComfyLtx2CreateVideoInput;
});
