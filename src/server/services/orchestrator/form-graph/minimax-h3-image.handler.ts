/** MiniMax H3 Image handler: one imageGen step on MiniMax's hosted API. */

import type { ImageGenStepTemplate } from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

// PENDING: the client ships no type for this engine yet, so the field names follow the
// orchestrator's MiniMaxH3ImageGenInput (civitai/civitai-orchestration#582, unmerged).
type MiniMaxH3ImageGenInput = {
  engine: 'minimax-h3-image';
  prompt: string;
  quantity: number;
  resolution?: '1K' | '2K' | '4K';
  aspectRatio?: string;
  images?: string[];
  disablePromptEnhancement?: boolean;
};

export const createMinimaxH3ImageInput = defineHandler<
  EcosystemData<'MiniMaxH3Image'>,
  [ImageGenStepTemplate]
>((data) => {
  const isEdit = !(data.workflow ?? '').startsWith('txt');
  const input: MiniMaxH3ImageGenInput = removeEmpty({
    engine: 'minimax-h3-image' as const,
    prompt: data.prompt ?? '',
    quantity: data.quantity ?? 1,
    resolution: data.resolution,
    ...(isEdit
      ? { aspectRatio: 'auto', images: data.images?.map((x) => x.url) ?? [] }
      : {
          aspectRatio: data.aspectRatio?.value,
          // Valid only on text-to-image with a fixed ratio, which this always sends.
          disablePromptEnhancement: data.enablePromptExpansion === false ? true : undefined,
        }),
  });
  return [{ $type: 'imageGen', input }];
});
