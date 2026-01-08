import type {
  Qwen20bCreateImageGenInput,
  Qwen20bEditImageGenInput,
  Qwen20bImageGenInput,
} from '@civitai/client';
import * as z from 'zod';
import {
  negativePromptSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

const engine = 'qwen';

type Txt2ImgVersion = '2509' | '2512';
type Img2ImgVersion = '2509' | '2511';

export const qwenModelVersionToModelMap = new Map<
  number,
  { modelId: number; process: string; version: Txt2ImgVersion | Img2ImgVersion }
>([
  [2110043, { modelId: 1864281, process: 'txt2img', version: '2509' }],
  [2552908, { modelId: 2268063, process: 'txt2img', version: '2512' }],
  [2133258, { modelId: 1884704, process: 'img2img', version: '2509' }],
  [2558804, { modelId: 2268063, process: 'img2img', version: '2511' }],
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

export function getIsQwenImageEditModel(resourceId: number) {
  return qwenModelVersionToModelMap.get(resourceId!)?.process === 'img2img';
}

export function getQwenProcess(resourceId: number) {
  return qwenModelVersionToModelMap.get(resourceId!)?.process ?? 'txt2img';
}

export function getQwenVersionOptions(resourceId: number) {
  const resource = qwenModelVersionToModelMap.get(resourceId);
  if (!resource) return null;
  return [...qwenModelVersionToModelMap.entries()]
    .filter(([_, { process }]) => process === resource.process)
    .map(([resourceId, { version }]) => ({ label: version, value: resourceId.toString() }));
}

export const qwenModelModeOptions = Array.from(qwenModelVersionToModelMap.entries()).map(
  ([key, { version }]) => ({
    label: version,
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
  loras: z.record(z.string(), z.number()).optional(),
});

export const qwenConfig = ImageGenConfig({
  metadataFn: (params) => {
    return {
      engine,
      process: params.images?.length ? 'img2img' : 'txt2img',
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
    };
  },
  inputFn: ({ params, resources, whatIf }) => {
    const resourceId =
      resources.find((resource) => qwenModelVersionToModelMap.get(resource.id))?.id ?? 2552908;
    const { process, version } = qwenModelVersionToModelMap.get(resourceId) ?? {
      modelId: 2268063,
      process: 'txt2img',
      version: '2512',
    };
    const loras = resources
      .filter((x) => x.id !== resourceId)
      .reduce<Record<string, number>>(
        (acc, curr) => (curr.air ? { ...acc, [curr.air]: curr.strength } : acc),
        {}
      );

    let imagesEditSchema = sourceImageSchema.array().max(7);
    let imagesVariantSchema = sourceImageSchema.array().max(1);
    if (!whatIf) {
      imagesEditSchema = imagesEditSchema.min(1);
      imagesVariantSchema = imagesVariantSchema.min(1);
    }

    const schema = z.discriminatedUnion('operation', [
      baseSchema.extend({
        operation: z.literal('createImage'),
      }),
      baseSchema
        .extend({
          operation: z.literal('editImage'),
          images: imagesEditSchema,
        })
        .transform((obj) => ({ ...obj, images: obj.images.map((x) => x.url) })),
      baseSchema
        .extend({
          operation: z.literal('createVariant'),
          images: imagesVariantSchema,
        })
        .transform(({ images, ...obj }) => ({ ...obj, image: images[0].url })),
    ]);

    if (process === 'txt2img') {
      return schema.parse({
        model: '20b',
        engine: 'sdcpp',
        ecosystem: 'qwen',
        version,
        operation: 'createImage',
        prompt: params.prompt,
        negativePrompt: params.negativePrompt,
        width: params.width,
        height: params.height,
        cfgScale: params.cfgScale,
        steps: params.steps,
        quantity: params.quantity,
        seed: params.seed,
        loras,
      }) as Qwen20bCreateImageGenInput;
    } else if (process === 'img2img') {
      return schema.parse({
        model: '20b',
        engine: 'sdcpp',
        ecosystem: 'qwen',
        version,
        operation: 'editImage',
        prompt: params.prompt,
        negativePrompt: params.negativePrompt,
        width: params.width,
        height: params.height,
        cfgScale: params.cfgScale,
        steps: params.steps,
        quantity: params.quantity,
        seed: params.seed,
        images: params.images?.map((x) => x.url) ?? [],
        loras,
      }) as Qwen20bEditImageGenInput;
    }

    throw new Error('Unsupported Qwen process type');
  },
});
