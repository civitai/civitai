/** Ideogram family handler for the form-graph lane — comfy (4.0) or fal (4.5, 4.6) imageGen. */

import type {
  ComfyIdeogram4CreateImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/orchestration-client';
import type {
  Ideogram45CreateFalImageGenInput,
  Ideogram45EditFalImageGenInput,
  Ideogram46CreateFalImageGenInput,
  Ideogram46EditFalImageGenInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

type FalInput =
  | Ideogram45CreateFalImageGenInput
  | Ideogram45EditFalImageGenInput
  | Ideogram46CreateFalImageGenInput
  | Ideogram46EditFalImageGenInput;

const falModels = { 'v4.5': 'ideogram45', 'v4.6': 'ideogram46' } as const;

export const createIdeogramInput = defineHandler<EcosystemData<'Ideogram'>, [ImageGenStepTemplate]>(
  (data, ctx) => {
    if (data.ideogramVersion === 'v4.5' || data.ideogramVersion === 'v4.6') {
      // A transparent background needs png or webp output.
      const transparent = 'transparent' in data && data.transparent;
      const baseInput = {
        engine: 'fal' as const,
        model: falModels[data.ideogramVersion],
        prompt: data.prompt ?? '',
        quantity: data.quantity ?? 1,
        seed: data.seed,
        quality: data.quality,
        ...(transparent && { background: 'transparent' as const, outputFormat: 'png' as const }),
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
              editPrecision: 'editPrecision' in data ? data.editPrecision : undefined,
            } as FalInput),
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
            enhancePrompt: data.enablePromptExpansion,
          } as FalInput),
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
