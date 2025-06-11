import type {
  OpenAIGpt1CreateImageInput,
  OpenAIGpt1EditImageInput,
  OpenAIGpt1ImageGenInput,
} from '@civitai/client';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';
import { findClosest } from '~/utils/number-helpers';

const openAISizes = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];
function getClosestOpenAISize(w: number, h: number) {
  const ratios = openAISizes.map(({ width, height }) => width / height);
  const closest = findClosest(ratios, w / h);
  const index = ratios.indexOf(closest);
  const { width, height } = openAISizes[index] ?? openAISizes[0];
  return { width, height };
}

export const openaiConfig = ImageGenConfig({
  metadataFn: (params) => ({
    engine: 'openai',
    baseModel: params.baseModel,
    prompt: params.prompt,
    // quality: params.openAIQuality,
    background: params.openAITransparentBackground ? 'transparent' : 'opaque',
    quality: params.openAIQuality,
    quantity: Math.min(params.quantity, 10),
    workflow: params.workflow,
    sourceImage: params.sourceImage,
    process: !params.sourceImage ? 'txt2img' : 'img2img',
    ...getClosestOpenAISize(
      params.sourceImage?.width ?? params.width,
      params.sourceImage?.height ?? params.height
    ),
  }),
  inputFn: ({ params }): OpenAIGpt1CreateImageInput | OpenAIGpt1EditImageInput => {
    const baseData = {
      engine: params.engine,
      model: 'gpt-image-1',
      prompt: params.prompt,
      background: params.background,
      quantity: params.quantity,
      quality: params.quality,
      size: `${params.width}x${params.height}`,
    } as Omit<OpenAIGpt1ImageGenInput, 'operation'>;
    if (!params.sourceImage) {
      return {
        ...baseData,
        operation: 'createImage',
      } satisfies OpenAIGpt1CreateImageInput;
    } else {
      return {
        ...baseData,
        operation: 'editImage',
        images: [params.sourceImage.url],
      } satisfies OpenAIGpt1EditImageInput;
    }
  },
});
