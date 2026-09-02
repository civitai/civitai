/** HiDream-O1 handler for the form-graph lane — comfy imageGen, dev/full × create/edit. */

import type {
  ComfyHiDreamO1CreateImageGenInput,
  ComfyHiDreamO1DevCreateImageGenInput,
  ComfyHiDreamO1DevEditImageGenInput,
  ComfyHiDreamO1EditImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { hiDreamO1VersionIds } from '~/shared/form-graph/generation/image/hi-dream-o1.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras } from './types';
import type { LooseGenerationData } from './types';

export const createHiDreamO1Input = defineHandler<LooseGenerationData, [ImageGenStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for HiDream-O1 workflows');
    if (!data.model) throw new Error('Model is required for HiDream-O1 workflows');

    const isDev = data.model.id === hiDreamO1VersionIds.dev;
    const isEdit = data.workflow === 'img2img:edit';

    const loras = resourcesToLoras(data.resources, ctx.airs);

    const images = isEdit ? data.images?.map((img) => img.url) : undefined;

    const base = {
      engine: 'comfy' as const,
      ecosystem: 'hidream-o1' as const,
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      steps: data.steps,
      cfgScale: data.cfgScale,
      seed: data.seed,
      quantity: data.quantity ?? 1,
      checkpointModel: ctx.airs.getOrThrow(data.model.id),
      loras,
    };

    const model = isDev ? ('HiDream-O1-Image-dev' as const) : ('HiDream-O1-Image' as const);
    const input = (
      isEdit
        ? removeEmpty({ ...base, operation: 'editImage', model, images })
        : removeEmpty({ ...base, operation: 'createImage', model })
    ) as
      | ComfyHiDreamO1CreateImageGenInput
      | ComfyHiDreamO1EditImageGenInput
      | ComfyHiDreamO1DevCreateImageGenInput
      | ComfyHiDreamO1DevEditImageGenInput;

    return [{ $type: 'imageGen', input } as ImageGenStepTemplate];
  }
);
