import type { GrokCreateImageGenInput, GrokEditImageGenInput } from '@civitai/client';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

export const grokModelVersionToModelMap = new Map<number, { name: string }>([
  [2738377, { name: 'grok-imagine' }],
]);

export const grokConfig = ImageGenConfig({
  metadataFn: (params) => {
    return {
      engine: 'grok',
      baseModel: params.baseModel,
      process: !params.images?.length ? 'txt2img' : 'img2img',
      prompt: params.prompt,
      quantity: params.quantity,
      images: params.images,
      width: params.width,
      height: params.height,
      aspectRatio: params.aspectRatio,
    };
  },
  inputFn: ({ params }): GrokCreateImageGenInput | GrokEditImageGenInput => {
    if (!params.images?.length) {
      return {
        engine: 'grok',
        operation: 'createImage',
        prompt: params.prompt,
        quantity: params.quantity,
        aspectRatio: params.aspectRatio as GrokCreateImageGenInput['aspectRatio'],
      } satisfies GrokCreateImageGenInput;
    }

    return {
      engine: 'grok',
      operation: 'editImage',
      prompt: params.prompt,
      quantity: params.quantity,
      images: params.images.map((x) => x.url),
    } satisfies GrokEditImageGenInput;
  },
});
