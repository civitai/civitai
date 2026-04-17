/**
 * Ernie Ecosystem Handler
 *
 * Handles Ernie (Baidu) workflows using imageGen step type with comfy engine.
 * Two models:
 * - Standard (ernie): ComfyErnieStandardCreateImageGenInput — supports LoRAs
 * - Turbo: ComfyErnieTurboCreateImageGenInput — no LoRA support
 */

import type {
  ComfyErnieStandardCreateImageGenInput,
  ComfyErnieTurboCreateImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { ernieVersionIds } from '~/shared/data-graph/generation/ernie-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type ErnieCtx = EcosystemGraphOutput & { ecosystem: 'Ernie' };

/**
 * Creates imageGen input for Ernie ecosystem.
 * Routes to standard or turbo input based on selected model version.
 */
export const createErnieInput = defineHandler<ErnieCtx, [ImageGenStepTemplate]>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for Ernie workflows');

  const isTurbo = data.model?.id === ernieVersionIds.turbo;

  if (isTurbo) {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'comfy',
          ecosystem: 'ernie',
          operation: 'createImage',
          model: 'turbo',
          prompt: data.prompt,
          negativePrompt: data.negativePrompt,
          width: data.aspectRatio.width,
          height: data.aspectRatio.height,
          cfgScale: data.cfgScale,
          steps: data.steps,
          sampler: 'euler',
          scheduler: 'simple',
          seed: data.seed,
          quantity: data.quantity ?? 1,
        }) as ComfyErnieTurboCreateImageGenInput,
      } as ImageGenStepTemplate,
    ];
  }

  // Standard model — supports LoRAs
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        engine: 'comfy',
        ecosystem: 'ernie',
        operation: 'createImage',
        model: 'ernie',
        prompt: data.prompt,
        negativePrompt: data.negativePrompt,
        width: data.aspectRatio.width,
        height: data.aspectRatio.height,
        cfgScale: data.cfgScale,
        steps: data.steps,
        sampler: 'euler',
        scheduler: 'simple',
        seed: data.seed,
        quantity: data.quantity ?? 1,
        loras: Object.keys(loras).length > 0 ? loras : undefined,
      }) as ComfyErnieStandardCreateImageGenInput,
    } as ImageGenStepTemplate,
  ];
});
