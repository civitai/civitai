/** Lens handler for the form-graph lane — comfy imageGen, base vs turbo. */

import type {
  ComfyLensNormalCreateImageGenInput,
  ComfyLensTurboCreateImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { lensVersionIds } from '~/shared/form-graph/generation/image/lens.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras } from './types';
import type { LooseGenerationData } from './types';

export const createLensInput = defineHandler<LooseGenerationData, [ImageGenStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for Lens workflows');

    const isTurbo = data.model?.id === lensVersionIds.turbo;

    const loras = resourcesToLoras(data.resources, ctx.airs);

    const base = {
      engine: 'comfy',
      ecosystem: 'lens',
      operation: 'createImage',
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
      loras,
    };

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({ ...base, model: isTurbo ? 'turbo' : 'normal' }) as
          | ComfyLensNormalCreateImageGenInput
          | ComfyLensTurboCreateImageGenInput,
      } as ImageGenStepTemplate,
    ];
  }
);
