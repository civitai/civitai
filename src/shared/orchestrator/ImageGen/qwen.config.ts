import type { Qwen20bImageGenInput } from '@civitai/client';
import { startCase } from 'lodash-es';
import * as z from 'zod';
import {
  negativePromptSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

type QwenModel = (typeof qwenModels)[number];
export const qwenModels = ['create', 'edit'] as const;
const engine = 'qwen';

export const qwenModelId = 1864281;
export const qwenEditModelId = 1884704;

export const qwenModelVersionToModelMap = new Map<number, { modelId: number; name: QwenModel }>([
  [2110043, { modelId: qwenModelId, name: 'create' }],
  [2133258, { modelId: qwenEditModelId, name: 'edit' }],
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

export function getIsQwenEditModel(resourceId: number) {
  return qwenModelVersionToModelMap.get(resourceId!)?.modelId === qwenEditModelId;
}

export const qwenModelModeOptions = Array.from(qwenModelVersionToModelMap.entries()).map(
  ([key, { name }]) => ({
    label: startCase(name),
    value: key.toString(),
  })
);

const baseSchema = z.object({
  engine: z.literal('sdcpp').catch('sdcpp'),
  ecosystem: z.literal(engine).catch(engine),
  model: z.literal('20b').catch('20b'),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema.optional(),
  width: z.number().optional(),
  height: z.number().optional(),
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
  baseSchema
    .extend({
      operation: z.literal('createVariant'),
      images: sourceImageSchema.array().min(1).max(1),
    })
    .transform(({ images, ...obj }) => ({ ...obj, image: images[0].url })),
]);

export const qwenConfig = ImageGenConfig({
  metadataFn: (params) => {
    return {
      engine,
      process: params.images?.length || params.sourceImage ? 'img2img' : 'txt2img',
      baseModel: params.baseModel,
      images: params.images,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      width: params.width,
      height: params.height,
      cfgScale: params.cfgScale,
      steps: params.steps,
      quantity: params.quantity,
      seed: params.seed,
      sourceImage: params.sourceImage,
    };
  },
  inputFn: ({ params, resources }): Qwen20bImageGenInput => {
    const [baseModel] = resources;
    const isQwenEdit = baseModel && getIsQwenEditModel(baseModel.id);

    return schema.parse({
      ...params,
      operation: isQwenEdit ? 'createVariant' : params.images?.length ? 'editImage' : 'createImage',
      images: isQwenEdit ? [params.sourceImage] : params.images,
      model: '20b',
    }) as unknown as Qwen20bImageGenInput;
  },
});
