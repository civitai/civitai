import type { Flux2DevImageGenInput } from '@civitai/client';
import { startCase } from 'lodash-es';
import * as z from 'zod';
import {
  promptSchema,
  resourceSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

type Flux2Model = (typeof flux2Models)[number];
export const flux2Models = ['dev', 'flex', 'pro', 'max'] as const;
const engine = 'flux2';

export const flux2ModelId = 983611;

export const flux2ModelVersionToModelMap = new Map<number, Flux2Model>([
  [2439067, 'dev'],
  [2439442, 'pro'],
  [2439047, 'flex'],
  [2547175, 'max'],
]);

export function getIsFlux2(modelVersionId?: number) {
  return modelVersionId ? !!flux2ModelVersionToModelMap.get(modelVersionId) : false;
}

export function getIsFlux2Dev(modelVersionId?: number) {
  if (!modelVersionId) return false;
  const model = flux2ModelVersionToModelMap.get(modelVersionId);
  return model === 'dev';
}

export function getIsFlux2FromResources(resources: { id: number }[]) {
  return resources.some((x) => !!flux2ModelVersionToModelMap.get(x.id));
}

export function getIsFlux2FromEngine(value?: string) {
  return value === engine;
}

export const flux2ModelModeOptions = Array.from(flux2ModelVersionToModelMap.entries()).map(
  ([key, value]) => ({
    label: startCase(value),
    value: key.toString(),
  })
);

const baseSchema = z.object({
  engine: z.literal(engine).catch(engine),
  model: z.enum(flux2Models),
  prompt: promptSchema,
  width: z.number(),
  height: z.number(),
  guidanceScale: z.number().optional(),
  numInferenceSteps: z.number().optional(),
  quantity: z.number().optional(),
  seed: seedSchema,
  loras: resourceSchema.array().optional(),
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

export const flux2Config = ImageGenConfig({
  metadataFn: (params) => {
    return {
      engine,
      process: !params.images?.length ? 'txt2img' : 'img2img',
      baseModel: params.baseModel,
      images: params.images,
      prompt: params.prompt,
      quantity: params.quantity,
      seed: params.seed,
      width: params.width,
      height: params.height,
      guidanceScale: params.cfgScale,
      numInferenceSteps: params.steps,
    };
  },
  inputFn: ({ params, resources }): Flux2DevImageGenInput => {
    let model: Flux2Model = 'dev';
    for (const resource of resources) {
      const match = flux2ModelVersionToModelMap.get(resource.id);
      if (match) model = match;
    }
    const loras = resources.slice(1); // first resource is always the flux2 model itself

    return schema.parse({
      ...params,
      operation: params.images?.length ? 'editImage' : 'createImage',
      model,
      loras,
    }) as unknown as Flux2DevImageGenInput; // TODO: fix any when typings accept pro | flex
  },
});
