import type {
  OpenAiGpt1CreateImageInput,
  OpenAiGpt1EditImageInput,
  OpenAiGpt1ImageGenInput,
} from '@civitai/client';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';

const openAISizes = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

type OpenaiModel = (typeof openaiModels)[number];
export const openaiModels = ['gpt-image-1', 'gpt-image-1.5'] as const;

export const openaiModelVersionToModelMap = new Map<number, { model: OpenaiModel; name: string }>([
  [1733399, { model: 'gpt-image-1', name: 'v1' }],
  [2512167, { model: 'gpt-image-1.5', name: 'v1.5' }],
]);

export const openaiConfig = ImageGenConfig({
  metadataFn: (params) => {
    const { width, height } = findClosestAspectRatio(params, openAISizes);
    const images = !!params.images?.length
      ? params.images
      : params.sourceImage
      ? [params.sourceImage]
      : undefined;

    return {
      engine: 'openai',
      baseModel: params.baseModel,
      process: !images?.length ? 'txt2img' : 'img2img',
      prompt: params.prompt,
      // quality: params.openAIQuality,
      background: params.openAITransparentBackground ? 'transparent' : 'opaque',
      quality: params.openAIQuality,
      quantity: Math.min(params.quantity, 10),
      images,
      width,
      height,
    };
  },
  inputFn: ({ params, resources }): OpenAiGpt1CreateImageInput | OpenAiGpt1EditImageInput => {
    const checkpoint = resources.find((resource) => openaiModelVersionToModelMap.get(resource.id));
    const model = checkpoint ? openaiModelVersionToModelMap.get(checkpoint.id)?.model : undefined;
    const baseData = {
      engine: params.engine,
      model: model ?? 'gpt-image-1',
      prompt: params.prompt,
      background: params.background,
      quantity: params.quantity,
      quality: params.quality,
      size: `${params.width}x${params.height}`,
    } as Omit<OpenAiGpt1ImageGenInput, 'operation'>;
    if (!params.images?.length) {
      return {
        ...baseData,
        operation: 'createImage',
      } satisfies OpenAiGpt1CreateImageInput;
    } else {
      return {
        ...baseData,
        operation: 'editImage',
        images: params.images.map((x) => x.url),
      } satisfies OpenAiGpt1EditImageInput;
    }
  },
});
