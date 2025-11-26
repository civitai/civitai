import { startCase } from 'lodash-es';
import * as z from 'zod';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

type Flux2Model = (typeof flux2Models)[number];
export const flux2Models = ['dev', 'flex', 'pro'] as const;
const engine = 'flux2';

export const flux2ModelId = 983611;

export const flux2ModelVersionToModelMap = new Map<number, Flux2Model>([
  [2439067, 'dev'],
  [2439047, 'flex'],
  [2439442, 'pro'],
]);

export function getIsFlux2(modelVersionId?: number) {
  return modelVersionId ? !!flux2ModelVersionToModelMap.get(modelVersionId) : false;
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

const schema = z.object({
  engine: z.literal(engine).catch(engine),
  model: z.enum(flux2Models),
  prompt: z.string(),
  quantity: z.number().optional(),
  seed: z.number().nullish(),
});

export const flux2Config = ImageGenConfig({
  metadataFn: (params) => {
    return {
      engine,
      process: 'txt2img',
      baseModel: params.baseModel,
      prompt: params.prompt,
      quantity: params.quantity,
      seed: params.seed,
    };
  },
  inputFn: ({ params, resources }) => {
    let model: Flux2Model = 'dev';
    for (const resource of resources) {
      const match = flux2ModelVersionToModelMap.get(resource.id);
      if (match) model = match;
    }

    return schema.parse({
      engine: params.engine,
      model,
      prompt: params.prompt,
      quantity: params.quantity,
      seed: params.seed,
    });
  },
});
