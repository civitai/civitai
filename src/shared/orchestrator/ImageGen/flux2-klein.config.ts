import type {
  Flux2KleinCreateImageInput,
  Flux2KleinEditImageInput,
  SdCppSampleMethod,
  SdCppSchedule,
} from '@civitai/client';
import * as z from 'zod';
import {
  negativePromptSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

type Flux2KleinModelVariant = (typeof flux2KleinModelVariants)[number];
export const flux2KleinModelVariants = ['4b', '4b-base', '9b', '9b-base'] as const;
const engine = 'flux2';

export const flux2KleinModelVersionToVariantMap = new Map<number, Flux2KleinModelVariant>([
  [2612557, '4b'],
  [2612552, '4b-base'],
  [2612554, '9b'],
  [2612548, '9b-base'],
]);

export function getIsFlux2Klein(modelVersionId?: number) {
  return modelVersionId ? !!flux2KleinModelVersionToVariantMap.get(modelVersionId) : false;
}

export function getIsFlux2KleinFromResources(resources: { id: number }[]) {
  return resources.some((x) => !!flux2KleinModelVersionToVariantMap.get(x.id));
}

export function getIsFlux2KleinFromEngine(value?: string) {
  return value === engine;
}

// Explicit labels to avoid startCase issues (e.g., '4b-base' -> '4 B Base')
const flux2KleinVariantLabels: Record<Flux2KleinModelVariant, string> = {
  '4b': '4B',
  '4b-base': '4B Base',
  '9b': '9B',
  '9b-base': '9B Base',
};

export const flux2KleinModelVariantOptions = Array.from(
  flux2KleinModelVersionToVariantMap.entries()
).map(([key, value]) => ({
  label: flux2KleinVariantLabels[value],
  value: key.toString(),
}));

// Default values per model variant
// 9b is distilled and doesn't need steps/cfgScale exposed
export const flux2KleinVariantDefaults: Record<
  Flux2KleinModelVariant,
  { steps: number; cfgScale: number; hideAdvanced: boolean }
> = {
  '4b': { steps: 12, cfgScale: 1, hideAdvanced: true },
  '4b-base': { steps: 20, cfgScale: 2.5, hideAdvanced: false },
  '9b': { steps: 12, cfgScale: 1, hideAdvanced: true },
  '9b-base': { steps: 20, cfgScale: 2.5, hideAdvanced: false },
};

export function getFlux2KleinDefaults(modelVersionId?: number) {
  if (!modelVersionId) return flux2KleinVariantDefaults['9b'];
  const variant = flux2KleinModelVersionToVariantMap.get(modelVersionId);
  return variant ? flux2KleinVariantDefaults[variant] : flux2KleinVariantDefaults['9b'];
}

export function getIsFlux2KleinDistilled(modelVersionId?: number) {
  if (!modelVersionId) return false;
  const variant = flux2KleinModelVersionToVariantMap.get(modelVersionId);
  return variant === '9b' || variant === '4b';
}

// Map variant to baseModel name
const flux2KleinVariantToBaseModel: Record<Flux2KleinModelVariant, string> = {
  '9b': 'Flux2Klein_9B',
  '9b-base': 'Flux2Klein_9B_base',
  '4b': 'Flux2Klein_4B',
  '4b-base': 'Flux2Klein_4B_base',
};

export function getFlux2KleinBaseModel(modelVersionId?: number): string | undefined {
  if (!modelVersionId) return undefined;
  const variant = flux2KleinModelVersionToVariantMap.get(modelVersionId);
  return variant ? flux2KleinVariantToBaseModel[variant] : undefined;
}

const flux2KleinGroups = Object.values(flux2KleinVariantToBaseModel);

export function getIsFlux2KleinGroup(baseModel: string) {
  return flux2KleinGroups.includes(baseModel);
}

export const flux2KleinSampleMethods = [
  'euler',
  'heun',
  'dpm++2s_a',
  'dpm++2m',
  'dpm++2mv2',
  'ipndm',
  'ipndm_v',
  'lcm',
] as const satisfies SdCppSampleMethod[];

export const flux2KleinSchedules = [
  'simple',
  'discrete',
  'karras',
  'exponential',
  // 'ays', // Disabled - fails 100% of the time
] as const satisfies SdCppSchedule[];

const baseSchema = z.object({
  engine: z.literal(engine).catch(engine),
  model: z.literal('klein').catch('klein'),
  modelVersion: z.enum(flux2KleinModelVariants),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema.optional(),
  width: z.number(),
  height: z.number(),
  cfgScale: z.number().optional(),
  steps: z.number().optional(),
  sampleMethod: z.enum(flux2KleinSampleMethods).optional(),
  schedule: z.enum(flux2KleinSchedules).optional(),
  quantity: z.number().optional(),
  seed: seedSchema,
  loras: z.record(z.string(), z.number()).optional(),
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

export const flux2KleinConfig = ImageGenConfig({
  metadataFn: (params, resources) => {
    let modelVersion: Flux2KleinModelVariant = '9b';
    for (const resource of resources) {
      const match = flux2KleinModelVersionToVariantMap.get(resource.id);
      if (match) modelVersion = match;
    }

    // For distilled variants (9b, 4b), enforce default steps and cfgScale
    const variantDefaults = flux2KleinVariantDefaults[modelVersion];
    const isDistilled = variantDefaults.hideAdvanced;
    const steps = isDistilled ? variantDefaults.steps : params.steps;
    const cfgScale = isDistilled ? variantDefaults.cfgScale : params.cfgScale;

    return {
      engine,
      process: !params.images?.length ? 'txt2img' : 'img2img',
      baseModel: params.baseModel,
      images: params.images,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      quantity: params.quantity,
      seed: params.seed,
      width: params.width,
      height: params.height,
      cfgScale,
      steps,
      sampler: params.sampler,
      scheduler: params.scheduler,
    };
  },
  inputFn: ({ params, resources }): Flux2KleinCreateImageInput | Flux2KleinEditImageInput => {
    let modelVersion: Flux2KleinModelVariant = '9b';
    for (const resource of resources) {
      const match = flux2KleinModelVersionToVariantMap.get(resource.id);
      if (match) modelVersion = match;
    }

    // Build loras map from resources (excluding the first resource which is the base model)
    const loraResources = resources.slice(1);
    const loras =
      loraResources.length > 0
        ? loraResources.reduce((acc, resource) => {
            if (!resource.air) return acc;
            acc[resource.air] = resource.strength;
            return acc;
          }, {} as Record<string, number>)
        : undefined;

    return schema.parse({
      ...params,
      operation: params.images?.length ? 'editImage' : 'createImage',
      modelVersion,
      sampleMethod: params.sampler ?? 'euler',
      schedule: params.scheduler ?? 'simple',
      loras,
    }) as Flux2KleinCreateImageInput | Flux2KleinEditImageInput;
  },
});
