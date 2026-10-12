/** Ideogram family handler for the form-graph lane — comfy (4.0) or fal (4.5) imageGen. */

import type { ComfyIdeogram4CreateImageGenInput, ImageGenStepTemplate } from '@civitai/client';
import type {
  Ideogram45CreateFalImageGenInput,
  Ideogram45EditFalImageGenInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

export const createIdeogramInput = defineHandler<EcosystemData<'Ideogram'>, [ImageGenStepTemplate]>(
  (data, ctx) => {
    if (data.ideogramVersion === 'v4.5') {
      const baseInput = {
        engine: 'fal' as const,
        model: 'ideogram45' as const,
        prompt: data.prompt ?? '',
        quantity: data.quantity ?? 1,
        seed: data.seed,
        quality: data.quality,
      };

      if (!(data.workflow ?? '').startsWith('txt')) {
        return [
          {
            $type: 'imageGen',
            input: removeEmpty({
              ...baseInput,
              operation: 'editImage',
              imageSize: 'auto',
              images: data.images?.map((x) => x.url) ?? [],
            }) as Ideogram45EditFalImageGenInput,
          },
        ];
      }

      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            ...baseInput,
            operation: 'createImage',
            width: data.aspectRatio?.width,
            height: data.aspectRatio?.height,
            enablePromptExpansion: data.enablePromptExpansion,
          }) as Ideogram45CreateFalImageGenInput,
        },
      ];
    }

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
