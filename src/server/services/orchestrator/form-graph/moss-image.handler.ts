import type {
  ComfyMossImageBaseCreateImageInput,
  ComfyMossImageSftCreateImageInput,
  ImageGenStepTemplate,
} from '@civitai/orchestration-client';
import { mossImageModelOf } from '~/shared/form-graph/generation/image/moss-image.graph';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

type MossImageInput = ComfyMossImageSftCreateImageInput | ComfyMossImageBaseCreateImageInput;

export const createMossImageInput = defineHandler<
  EcosystemData<'MossImage'>,
  [ImageGenStepTemplate]
>((data, ctx) => [
  {
    $type: 'imageGen',
    input: removeEmpty<MossImageInput>({
      engine: 'comfy',
      ecosystem: 'mossImage',
      model: mossImageModelOf(data.model),
      operation: 'createImage',
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio?.width,
      height: data.aspectRatio?.height,
      steps: data.steps,
      cfgScale: data.cfgScale,
      quantity: data.quantity ?? 1,
      seed: data.seed,
      loras: resourcesToLoras(data.resources, ctx.airs),
    }),
  },
]);
