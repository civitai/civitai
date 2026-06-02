/**
 * Lens Ecosystem Handler
 *
 * Handles the Civitai-internal Lens workflows using imageGen step type with
 * comfy engine. Two variants:
 * - Normal: ComfyLensNormalCreateImageGenInput
 * - Turbo:  ComfyLensTurboCreateImageGenInput
 *
 * Both variants accept the same parameter shape and both support LoRAs.
 */

import type {
  ComfyLensNormalCreateImageGenInput,
  ComfyLensTurboCreateImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { lensVersionIds } from '~/shared/data-graph/generation/lens-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type LensCtx = EcosystemGraphOutput & { ecosystem: 'Lens' };

/**
 * Creates imageGen input for Lens ecosystem.
 * Routes to normal or turbo input based on selected model version.
 */
export const createLensInput = defineHandler<LensCtx, [ImageGenStepTemplate]>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for Lens workflows');

  const isTurbo = data.model?.id === lensVersionIds.turbo;

  // Both variants support LoRAs
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }
  const lorasInput = Object.keys(loras).length > 0 ? loras : undefined;

  if (isTurbo) {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'comfy',
          ecosystem: 'lens',
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
          loras: lorasInput,
        }) as ComfyLensTurboCreateImageGenInput,
      } as ImageGenStepTemplate,
    ];
  }

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        engine: 'comfy',
        ecosystem: 'lens',
        operation: 'createImage',
        model: 'normal',
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
        loras: lorasInput,
      }) as ComfyLensNormalCreateImageGenInput,
    } as ImageGenStepTemplate,
  ];
});
