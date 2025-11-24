import type {
  Gemini25FlashCreateImageGenInput,
  Gemini25FlashEditImageGenInput,
  NanoBananaProImageGenInput,
} from '@civitai/client';
import * as z from 'zod';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';
import { removeEmpty } from '~/utils/object-helpers';

export const imagen4AspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;

type GeminiModel = (typeof geminiModels)[number];
export const geminiModels = ['2.5-flash', 'nano-banana-pro'] as const;

export const geminiModelVersionMap = new Map<number, { model: GeminiModel; name: string }>([
  [2154472, { model: '2.5-flash', name: 'Standard' }],
  [2436219, { model: 'nano-banana-pro', name: 'Pro' }],
]);

export const nanoBananaProResolutions = ['1K', '2K', '4K'];

export function getIsNanoBanana(modelVersionId?: number) {
  return modelVersionId ? !!geminiModelVersionMap.get(modelVersionId) : false;
}

export function getIsNanoBananaFromResources(resources: { id: number }[]) {
  return resources.some((x) => !!geminiModelVersionMap.get(x.id));
}

export function getIsNanoBananaPro(modelVersionId?: number) {
  return modelVersionId
    ? geminiModelVersionMap.get(modelVersionId)?.model === 'nano-banana-pro'
    : false;
}

const baseSchema = z.object({
  engine: z.literal('gemini').catch('gemini'),
  model: z.enum(geminiModels),
  prompt: z.string(),
  quantity: z.number(),
});

const schema = z.discriminatedUnion('operation', [
  baseSchema.extend({
    operation: z.literal('createImage'),
  }),
  baseSchema
    .extend({
      operation: z.literal('editImage'),
      images: sourceImageSchema.array(),
    })
    .transform((obj) => ({ ...obj, images: obj.images.map((x) => x.url) })),
]);

export const geminiConfig = ImageGenConfig({
  metadataFn: (params, resources) => {
    const isPro = resources.some((x) => getIsNanoBanana(x.id));

    if (isPro) {
      return {
        engine: 'google',
        baseModel: params.baseModel,
        process: !params.images?.length ? 'txt2img' : 'img2img',
        images: params.images,
        prompt: params.prompt,
        quantity: params.quantity,
        resolution: params.resolution,
        aspectRatio: params.aspectRatio,
        negativePrompt: params.negativePrompt,
        outputFormat: params.outputFormat,
      };
    } else
      return {
        engine: 'gemini',
        baseModel: params.baseModel,
        process: !params.images?.length ? 'txt2img' : 'img2img',
        images: params.images,
        prompt: params.prompt,
        quantity: params.quantity,
      };
  },
  inputFn: ({ params, resources }) => {
    let model: GeminiModel = '2.5-flash';
    for (const resource of resources) {
      const match = geminiModelVersionMap.get(resource.id);
      if (match) model = match.model;
    }

    if (model === '2.5-flash')
      return schema.parse({
        engine: 'gemini',
        prompt: params.prompt,
        images: params.images?.map((x) => x.url),
        operation: params.images?.length ? 'editImage' : 'createImage',
        model,
        quantity: params.quantity,
      }) as Gemini25FlashCreateImageGenInput | Gemini25FlashEditImageGenInput;
    else
      return {
        ...params,
        engine: 'google',
        model,
        images: params.images?.map((x) => x.url),
        numImages: params.quantity,
      } as NanoBananaProImageGenInput;
  },
});
