/** Wan IMAGE handler for the form-graph lane — the v2.7 fal imageGen branch. */

import type {
  ImageGenStepTemplate,
  Wan27FalImageEditInput,
  Wan27FalTextToImageInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

export const createWanImageInput = defineHandler<LooseGenerationData, [ImageGenStepTemplate]>(
  (data) => {
    const hasImages = !!data.images?.length;

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'wan' as const,
          version: 'v2.7' as const,
          provider: 'fal' as const,
          prompt: data.prompt,
          negativePrompt: data.negativePrompt,
          guidanceScale: data.cfgScale,
          seed: data.seed,
          quantity: data.quantity ?? 1,
          aspectRatio: data.aspectRatio?.value,
          enablePromptExpansion: (data as { enablePromptEnhancer?: boolean }).enablePromptEnhancer,
          ...(hasImages
            ? { operation: 'editImage', images: data.images!.map((x) => x.url) }
            : { operation: 'createImage' }),
        }) as Wan27FalTextToImageInput | Wan27FalImageEditInput,
      },
    ];
  }
);
