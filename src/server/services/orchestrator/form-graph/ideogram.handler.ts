/** Ideogram 4 handler for the form-graph lane — comfy imageGen. */

import type { ComfyIdeogram4CreateImageGenInput, ImageGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

export const createIdeogramInput = defineHandler<EcosystemData<'Ideogram'>, [ImageGenStepTemplate]>(
  (data, ctx) => {
    // No `diffusionModel`: the official checkpoint bundles the conditional and
    // unconditional weights in several precisions, so its AIR names no single file.
    const input: ComfyIdeogram4CreateImageGenInput = {
      engine: 'comfy',
      ecosystem: 'ideogram4',
      operation: 'createImage',
      prompt: data.prompt ?? '',
      width: data.aspectRatio?.width,
      height: data.aspectRatio?.height,
      cfgScale: data.cfgScale,
      steps: data.steps,
      seed: data.seed,
      quantity: data.quantity ?? 1,
      outputFormat: data.outputFormat,
      loras: resourcesToLoras(data.resources, ctx.airs),
    };

    return [{ $type: 'imageGen', input: removeEmpty(input) }];
  }
);
