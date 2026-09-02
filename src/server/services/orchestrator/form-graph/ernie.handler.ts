/** Ernie handler for the form-graph lane — comfy imageGen; turbo drops LoRAs. */

import type {
  ComfyErnieStandardCreateImageGenInput,
  ComfyErnieTurboCreateImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { ernieVersionIds } from '~/shared/form-graph/generation/image/ernie.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

export const createErnieInput = defineHandler<EcosystemData<'Ernie'>, [ImageGenStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for Ernie workflows');

    const isTurbo = data.model?.id === ernieVersionIds.turbo;

    const base = {
      engine: 'comfy',
      ecosystem: 'ernie',
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
    };

    if (isTurbo) {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty({ ...base, model: 'turbo' }) as ComfyErnieTurboCreateImageGenInput,
        } as ImageGenStepTemplate,
      ];
    }

    const loras = resourcesToLoras('resources' in data ? data.resources : undefined, ctx.airs);

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...base,
          model: 'ernie',
          loras,
        }) as ComfyErnieStandardCreateImageGenInput,
      } as ImageGenStepTemplate,
    ];
  }
);
