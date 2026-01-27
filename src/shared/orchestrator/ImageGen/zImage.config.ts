import type {
  ZImageTurboCreateImageGenInput,
  ZImageBaseCreateImageGenInput,
} from '@civitai/client';
import * as z from 'zod';
import { promptSchema, seedSchema } from '~/server/orchestrator/infrastructure/base.schema';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

const engine = 'zImage';

type ZImageModel = 'turbo' | 'base';

export const zImageModelVersionToModelMap = new Map<
  number,
  { modelId: number; model: ZImageModel; name: string; baseModel: string }
>([
  [2442439, { modelId: 2168935, model: 'turbo', name: 'Turbo', baseModel: 'ZImageTurbo' }],
  [2635223, { modelId: 2342797, model: 'base', name: 'Base', baseModel: 'ZImageBase' }],
]);

export const zImageModelModeOptions = Array.from(zImageModelVersionToModelMap.entries()).map(
  ([key, value]) => ({
    label: value.name,
    value: key.toString(),
  })
);

export function getIsZImage(modelVersionId?: number) {
  return modelVersionId ? !!zImageModelVersionToModelMap.get(modelVersionId) : false;
}

export function getIsZImageFromEngine(value?: string) {
  return value === engine;
}

const baseSchema = z.object({
  engine: z.literal('sdcpp').catch('sdcpp'),
  ecosystem: z.literal('zImage').catch('zImage'),
  model: z.enum(['turbo', 'base']),
  prompt: promptSchema,
  width: z.number().optional(),
  height: z.number().optional(),
  cfgScale: z.number().optional(),
  steps: z.number().optional(),
  quantity: z.number().optional(),
  seed: seedSchema,
  loras: z.record(z.string(), z.number()).optional(),
});

export const zImageConfig = ImageGenConfig({
  metadataFn: (params) => {
    return {
      engine,
      process: 'txt2img',
      baseModel: params.baseModel,
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      cfgScale: params.cfgScale,
      steps: params.steps,
      quantity: params.quantity,
      seed: params.seed,
    };
  },
  inputFn: ({
    params,
    resources,
  }): ZImageTurboCreateImageGenInput | ZImageBaseCreateImageGenInput => {
    const resourceId =
      resources.find((resource) => zImageModelVersionToModelMap.get(resource.id))?.id ?? 2442439;
    const { model } = zImageModelVersionToModelMap.get(resourceId) ?? {
      modelId: 2168935,
      model: 'turbo' as ZImageModel,
      name: 'Turbo',
    };
    const loras = resources
      .filter((x) => x.id !== resourceId)
      .reduce<Record<string, number>>(
        (acc, curr) => (curr.air ? { ...acc, [curr.air]: curr.strength } : acc),
        {}
      );

    const schema = baseSchema.extend({
      operation: z.literal('createImage'),
    });

    return schema.parse({
      engine: 'sdcpp',
      ecosystem: 'zImage',
      model,
      operation: 'createImage',
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      cfgScale: params.cfgScale,
      steps: params.steps,
      quantity: params.quantity,
      seed: params.seed,
      loras,
    }) as ZImageTurboCreateImageGenInput | ZImageBaseCreateImageGenInput;
  },
});
