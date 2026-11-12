/** MiniMax H3 Image handler: one comfy imageGen step on our own workers. */

import type { ImageGenStepTemplate } from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { minimaxH3ImageResolutionScale } from '~/shared/form-graph/generation/image/minimax-h3-image.graph';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

// The client ships no type for this input yet (0.2.2); the shape is the orchestrator's
// ComfyMiniMaxH3ImageGenInput (civitai/civitai-orchestration#586).
type ComfyMiniMaxH3ImageInput = {
  engine: 'comfy';
  ecosystem: 'h3-image';
  operation: 'createImage' | 'editImage';
  prompt: string;
  width: number;
  height: number;
  quantity: number;
  seed?: number;
  images?: string[];
  diffusionModel?: null;
};

export const createMinimaxH3ImageInput = defineHandler<
  EcosystemData<'MiniMaxH3Image'>,
  [ImageGenStepTemplate]
>((data) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required');
  const isEdit = !(data.workflow ?? '').startsWith('txt');
  const scale = minimaxH3ImageResolutionScale[data.resolution ?? '2K'];
  const input: ComfyMiniMaxH3ImageInput = removeEmpty({
    engine: 'comfy' as const,
    ecosystem: 'h3-image' as const,
    operation: isEdit ? ('editImage' as const) : ('createImage' as const),
    prompt: data.prompt ?? '',
    width: data.aspectRatio.width * scale,
    height: data.aspectRatio.height * scale,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    images: isEdit ? data.images?.map((x) => x.url) ?? [] : undefined,
  });
  // Null selects the engine's default weights. The site version's own AIR is not a
  // checkpoint the engine can load.
  return [{ $type: 'imageGen', input: { ...input, diffusionModel: null } }];
});
