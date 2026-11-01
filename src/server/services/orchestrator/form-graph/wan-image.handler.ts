/** Wan IMAGE handler for the form-graph lane — the v2.7 fal imageGen branch. */

import type {
  ImageGenStepTemplate,
  Wan27FalImageEditInput,
  Wan27FalTextToImageInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

/** The input takes fal's size presets, not a ratio; unmapped ratios fall back to its square default. */
const imageSizeByAspectRatio: Record<string, string> = {
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
};

export const createWanImageInput = defineHandler<
  EcosystemData<'WanImage27'>,
  [ImageGenStepTemplate]
>((data) => {
  const hasImages = !!data.images?.length;
  const aspectRatio = data.aspectRatio?.value;

  return [
    {
      $type: 'imageGen',
      input: removeEmpty<Wan27FalTextToImageInput | Wan27FalImageEditInput>({
        engine: 'wan' as const,
        version: 'v2.7' as const,
        provider: 'fal' as const,
        prompt: data.prompt,
        negativePrompt: data.negativePrompt,
        cfgScale: data.cfgScale,
        seed: data.seed,
        quantity: data.quantity ?? 1,
        enhancePrompt: data.enablePromptEnhancer,
        ...(hasImages
          ? { operation: 'editImage', images: data.images!.map((x) => x.url) }
          : {
              operation: 'createImage',
              imageSize: aspectRatio ? imageSizeByAspectRatio[aspectRatio] : undefined,
            }),
      }),
    },
  ];
});
