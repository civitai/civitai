import type { Qwen20bCreateImageGenInput, Qwen20bEditImageGenInput } from '@civitai/client';
import * as z from 'zod';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

type QwenModel = (typeof qwenModels)[number];
export const qwenModels = ['20b'] as const;

export const qwenModelVersionToModelMap = new Map<number, QwenModel>([
  [2154472, '20b'],
  [2110043, '20b'],
]);

export function getIsQwen(modelVersionId?: number) {
  return modelVersionId ? !!qwenModelVersionToModelMap.get(modelVersionId) : false;
}

export function getIsQwenFromResources(resources: { id: number }[]) {
  return resources.some((x) => !!qwenModelVersionToModelMap.get(x.id));
}

const baseSchema = z.object({
  engine: z.literal('qwen').catch('qwen'),
  model: z.enum(qwenModels),
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  quantity: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  steps: z.number().optional(),
  cfgScale: z.number().optional(),
});

const schema = z.discriminatedUnion('operation', [
  baseSchema.extend({
    operation: z.literal('createImage'),
  }),
  baseSchema.extend({
    operation: z.literal('editImage'),
    image: z.string(),
  }),
]);

export const qwenConfig = ImageGenConfig({
  metadataFn: (params) => ({
    engine: 'qwen',
    baseModel: params.baseModel,
    process: !params.sourceImage ? 'txt2img' : 'img2img',
    sourceImage: params.sourceImage,
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    quantity: params.quantity,
    width: params.width,
    height: params.height,
    steps: params.steps,
    cfgScale: params.cfgScale,
  }),
  inputFn: ({ params, resources }): Qwen20bCreateImageGenInput | Qwen20bEditImageGenInput => {
    let model = '20b';
    for (const resource of resources) {
      const match = qwenModelVersionToModelMap.get(resource.id);
      if (match) model = match;
    }

    console.log({
      ...params,
      engine: params.engine,
      prompt: params.prompt,
      image: params.sourceImage,
      operation: params.sourceImage ? 'editImage' : 'createImage',
      model,
      quantity: params.quantity,
    });

    return schema.parse({
      ...params,
      operation: params.sourceImage ? 'editImage' : 'createImage',
      engine: params.engine,
      prompt: params.prompt,
      image: params.sourceImage?.url,
      model,
      quantity: params.quantity,
    });
  },
});
