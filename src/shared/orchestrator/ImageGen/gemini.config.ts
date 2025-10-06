import type {
  Gemini25FlashCreateImageGenInput,
  Gemini25FlashEditImageGenInput,
} from '@civitai/client';
import * as z from 'zod';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

export const imagen4AspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;

type GeminiModel = (typeof geminiModels)[number];
export const geminiModels = ['2.5-flash'] as const;

export const geminiModelVersionToModelMap = new Map<number, GeminiModel>([[2154472, '2.5-flash']]);

export function getIsNanoBanana(modelVersionId?: number) {
  return modelVersionId ? !!geminiModelVersionToModelMap.get(modelVersionId) : false;
}

export function getIsNanoBananaFromResources(resources: { id: number }[]) {
  return resources.some((x) => !!geminiModelVersionToModelMap.get(x.id));
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
  metadataFn: (params) => ({
    engine: 'gemini',
    baseModel: params.baseModel,
    process: !params.images?.length ? 'txt2img' : 'img2img',
    images: params.images,
    prompt: params.prompt,
    quantity: params.quantity,
  }),
  inputFn: ({
    params,
    resources,
  }): Gemini25FlashCreateImageGenInput | Gemini25FlashEditImageGenInput => {
    let model = '2.5-flash';
    for (const resource of resources) {
      const match = geminiModelVersionToModelMap.get(resource.id);
      if (match) model = match;
    }

    return schema.parse({
      engine: params.engine,
      prompt: params.prompt,
      images: params.images,
      operation: params.images?.length ? 'editImage' : 'createImage',
      model,
      quantity: params.quantity,
    });
  },
});
