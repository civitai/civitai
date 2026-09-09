import type {
  OpenAiGpt1CreateImageInput,
  OpenAiGpt1EditImageInput,
  OpenAiGpt1ImageGenInput,
  OpenAiGpt2CreateImageInput,
  OpenAiGpt2EditImageInput,
} from '@civitai/client';
import type {
  OpenAiGpt25FlareCreateImageInput,
  OpenAiGpt25FlareEditImageInput,
  OpenAiGpt25SunburstCreateImageInput,
  OpenAiGpt25SunburstEditImageInput,
} from '@civitai/orchestration-client';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';

const openAISizes = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

type OpenaiModel = (typeof openaiModels)[number];
export const openaiModels = [
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
] as const;

export const openaiModelVersionToModelMap = new Map<number, { model: OpenaiModel; name: string }>([
  [1733399, { model: 'gpt-image-1', name: 'v1' }],
  [2512167, { model: 'gpt-image-1.5', name: 'v1.5' }],
  [2880272, { model: 'gpt-image-2', name: 'v2' }],
  [3311434, { model: 'gpt-image-2.5-flare', name: 'v2.5 Flare' }],
  [3311436, { model: 'gpt-image-2.5-sunburst', name: 'v2.5 Sunburst' }],
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
  inputFn: ({
    params,
    resources,
  }):
    | OpenAiGpt1CreateImageInput
    | OpenAiGpt1EditImageInput
    | OpenAiGpt2CreateImageInput
    | OpenAiGpt2EditImageInput
    | OpenAiGpt25FlareCreateImageInput
    | OpenAiGpt25FlareEditImageInput
    | OpenAiGpt25SunburstCreateImageInput
    | OpenAiGpt25SunburstEditImageInput => {
    const checkpoint = resources.find((resource) => openaiModelVersionToModelMap.get(resource.id));
    const model = checkpoint ? openaiModelVersionToModelMap.get(checkpoint.id)?.model : undefined;

    if (
      model === 'gpt-image-2' ||
      model === 'gpt-image-2.5-flare' ||
      model === 'gpt-image-2.5-sunburst'
    ) {
      const baseData = {
        engine: params.engine,
        model,
        prompt: params.prompt,
        quantity: params.quantity,
        // gpt-image-2 and 2.5 have no 'auto' in their quality enum (gpt-image-1 does); clamp it.
        quality: params.quality === 'auto' ? 'high' : params.quality,
        width: params.width,
        height: params.height,
      };

      if (!params.images?.length) {
        return {
          ...baseData,
          operation: 'createImage',
        } as
          | OpenAiGpt2CreateImageInput
          | OpenAiGpt25FlareCreateImageInput
          | OpenAiGpt25SunburstCreateImageInput;
      } else {
        return {
          ...baseData,
          operation: 'editImage',
          images: params.images.map((x) => x.url),
        } as
          | OpenAiGpt2EditImageInput
          | OpenAiGpt25FlareEditImageInput
          | OpenAiGpt25SunburstEditImageInput;
      }
    }

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
      } as OpenAiGpt1CreateImageInput;
    } else {
      return {
        ...baseData,
        operation: 'editImage',
        images: params.images.map((x) => x.url),
      } as OpenAiGpt1EditImageInput;
    }
  },
});
