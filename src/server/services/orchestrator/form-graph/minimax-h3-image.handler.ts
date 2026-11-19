/** MiniMax H3 Image handler: one comfy imageGen step on our own workers. */

import type {
  ComfyMiniMaxH3CreateImageInput,
  ComfyMiniMaxH3EditImageInput,
  ImageGenStepTemplate,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { minimaxH3ImageResolutionScale } from '~/shared/form-graph/generation/image/minimax-h3-image.graph';
import { defineHandler } from '../handlers/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

export const createMinimaxH3ImageInput = defineHandler<
  EcosystemData<'MiniMaxH3Image'>,
  [ImageGenStepTemplate]
>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required');
  const isEdit = !(data.workflow ?? '').startsWith('txt');
  const scale = minimaxH3ImageResolutionScale[data.resolution ?? '2K'];
  const shared = {
    engine: 'comfy' as const,
    ecosystem: 'h3-image' as const,
    prompt: data.prompt ?? '',
    width: data.aspectRatio.width * scale,
    height: data.aspectRatio.height * scale,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    loras: resourcesToLoras(data.resources, ctx.airs),
  };
  const input: ComfyMiniMaxH3CreateImageInput | ComfyMiniMaxH3EditImageInput = isEdit
    ? { ...shared, operation: 'editImage', images: data.images?.map((x) => x.url) ?? [] }
    : { ...shared, operation: 'createImage' };
  const diffusionModel = data.model ? ctx.airs.getOrThrow(data.model.id) : undefined;
  return [{ $type: 'imageGen', input: removeEmpty({ ...input, diffusionModel }) }];
});
