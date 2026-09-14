/**
 * Ideogram Ecosystem Handler
 *
 * Handles Ideogram 4 workflows using imageGen step type.
 * Uses the comfy engine with ComfyIdeogram4CreateImageGenInput.
 */

import type { ComfyIdeogram4CreateImageGenInput, ImageGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type IdeogramCtx = EcosystemGraphOutput & { ecosystem: 'Ideogram' };

export const createIdeogramInput = defineHandler<IdeogramCtx, [ImageGenStepTemplate]>(
  (data, ctx) => {
    const loras: Record<string, number> = {};
    if ('resources' in data && Array.isArray(data.resources)) {
      for (const resource of data.resources as ResourceData[]) {
        loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
      }
    }

    // No `diffusionModel`: the official checkpoint bundles the conditional and
    // unconditional weights in several precisions, so its AIR names no single file.
    const input: ComfyIdeogram4CreateImageGenInput = {
      engine: 'comfy',
      ecosystem: 'ideogram4',
      operation: 'createImage',
      prompt: data.prompt,
      width: data.aspectRatio?.width,
      height: data.aspectRatio?.height,
      cfgScale: data.cfgScale,
      steps: data.steps,
      seed: data.seed,
      quantity: data.quantity ?? 1,
      outputFormat: data.outputFormat,
      loras: Object.keys(loras).length > 0 ? loras : undefined,
    };

    return [{ $type: 'imageGen', input: removeEmpty(input) }];
  }
);
