import type {
  ZImageTurboCreateImageGenInput,
  ZImageBaseCreateImageGenInput,
  SdCppSampleMethod,
  SdCppSchedule,
} from '@civitai/client';
import * as z from 'zod';
import type { Sampler } from '~/server/common/constants';
import { promptSchema, seedSchema } from '~/server/orchestrator/infrastructure/base.schema';
import { samplersToSdCpp } from '~/shared/constants/generation.constants';
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

const sdCppSampleMethods = [
  'euler',
  'heun',
  'dpm2',
  'dpm++2s_a',
  'dpm++2m',
  'dpm++2mv2',
  'ipndm',
  'ipndm_v',
  'ddim_trailing',
  'euler_a',
  'lcm',
] as const satisfies SdCppSampleMethod[];

const sdCppSchedules = [
  'simple',
  'discrete',
  'karras',
  'exponential',
  'ays',
] as const satisfies SdCppSchedule[];

const baseSchema = z.object({
  engine: z.literal('sdcpp').catch('sdcpp'),
  ecosystem: z.literal('zImage').catch('zImage'),
  model: z.enum(['turbo', 'base']),
  prompt: promptSchema,
  width: z.number().optional(),
  height: z.number().optional(),
  cfgScale: z.number().optional(),
  steps: z.number().optional(),
  sampleMethod: z.enum(sdCppSampleMethods).optional(),
  schedule: z.enum(sdCppSchedules).optional(),
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
      sampler: params.sampler,
      scheduler: params.scheduler,
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

    // Convert UI sampler to SdCpp sampleMethod, use scheduler from params if provided (only for 'base' model)
    const sdCppSampler =
      model === 'base'
        ? {
            sampleMethod: samplersToSdCpp[params.sampler as Sampler | 'undefined']?.sampleMethod,
            schedule: (params.scheduler as SdCppSchedule) ?? 'karras',
          }
        : undefined;

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
      sampleMethod: sdCppSampler?.sampleMethod,
      schedule: sdCppSampler?.schedule,
      quantity: params.quantity,
      seed: params.seed,
      loras,
    }) as ZImageTurboCreateImageGenInput | ZImageBaseCreateImageGenInput;
  },
});
