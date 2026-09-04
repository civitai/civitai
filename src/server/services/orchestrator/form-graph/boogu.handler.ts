/**
 * Boogu handler for the form-graph lane — imageGen steps on the comfy engine;
 * the model string routes by version id, edit variants take source images.
 */

import type {
  ComfyBooguBaseCreateImageGenInput,
  ComfyBooguTurboCreateImageGenInput,
  ComfyBooguEditImageInput,
  ComfyBooguEditTurboImageInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { booguModeOf, type BooguMode } from '~/shared/form-graph/generation/image/boogu.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

type BooguInput =
  | ComfyBooguBaseCreateImageGenInput
  | ComfyBooguTurboCreateImageGenInput
  | ComfyBooguEditImageInput
  | ComfyBooguEditTurboImageInput;

export const createBooguInput = defineHandler<EcosystemData<'Boogu'>, [ImageGenStepTemplate]>(
  (data, ctx) => {
    const model: BooguMode = booguModeOf(data.model, { workflow: data.workflow ?? '' });

    const loras = resourcesToLoras(data.resources, ctx.airs);

    const isEdit = model === 'edit' || model === 'editTurbo';

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'comfy',
          ecosystem: 'boogu',
          model,
          operation: isEdit ? 'editImage' : 'createImage',
          ...(isEdit ? { images: data.images?.map((x) => x.url) ?? [] } : {}),
          prompt: data.prompt,
          negativePrompt: data.negativePrompt,
          width: data.aspectRatio?.width,
          height: data.aspectRatio?.height,
          cfgScale: data.cfgScale,
          steps: data.steps,
          quantity: data.quantity ?? 1,
          seed: data.seed,
          loras,
        }) as BooguInput,
      },
    ];
  }
);
