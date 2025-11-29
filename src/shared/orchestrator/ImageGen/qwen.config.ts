import type { Qwen20bImageGenInput } from '@civitai/client';
import { startCase } from 'lodash-es';
import * as z from 'zod';
import {
  negativePromptSchema,
  promptSchema,
  resourceSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

type QwenModel = (typeof qwenModels)[number];
export const qwenModels = ['full'] as const;
const engine = 'qwen';

export const qwenModelId = 1864281;

export const qwenModelVersionToModelMap = new Map<number, QwenModel>([
  [2113658, 'full'], // Qwen Full BF16
]);

export function getIsQwen(modelVersionId?: number) {
  return modelVersionId ? !!qwenModelVersionToModelMap.get(modelVersionId) : false;
}

export function getIsQwenFromResources(resources: { id: number }[]) {
  return resources.some((x) => !!qwenModelVersionToModelMap.get(x.id));
}

export function getIsQwenFromEngine(value?: string) {
  return value === engine;
}

export const qwenModelModeOptions = Array.from(qwenModelVersionToModelMap.entries()).map(
  ([key, value]) => ({
    label: startCase(value),
    value: key.toString(),
  })
);

const baseSchema = z.object({
  engine: z.literal(engine).catch(engine),
  model: z.literal('20b').catch('20b'),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema.optional(),
  cfgScale: z.number().optional(),
  steps: z.number().optional(),
  quantity: z.number().optional(),
  seed: seedSchema,
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

export const qwenConfig = ImageGenConfig({
  metadataFn: (params) => {
    return {
      engine,
      process: !params.images?.length ? 'txt2img' : 'img2img',
      baseModel: params.baseModel,
      images: params.images,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      quantity: params.quantity,
      seed: params.seed,
      cfgScale: params.cfgScale,
      steps: params.steps,
    };
  },
  inputFn: ({ params }): Qwen20bImageGenInput => {
    return schema.parse({
      ...params,
      operation: params.images?.length ? 'editImage' : 'createImage',
      model: '20b',
    }) as unknown as Qwen20bImageGenInput;
  },
});
