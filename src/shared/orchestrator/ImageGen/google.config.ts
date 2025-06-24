import type { Imagen4ImageGenInput } from '@civitai/client';
import { z } from 'zod';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

export const imagen4AspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;

type GoogleModel = (typeof googleModels)[number];
export const googleModels = ['imagen4'] as const;

export const googleModelVersionToModelMap = new Map<number, GoogleModel>([[1889632, 'imagen4']]);

export function getIsImagen4(modelVersionId?: number) {
  return modelVersionId ? !!googleModelVersionToModelMap.get(modelVersionId) : false;
}

export function getIsImagen4FromResources(resources: { id: number }[]) {
  return resources.some((x) => !!googleModelVersionToModelMap.get(x.id));
}

const schema = z.object({
  engine: z.literal('google').catch('google'),
  model: z.enum(googleModels),
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  aspectRatio: z.enum(imagen4AspectRatios).optional(),
  numImages: z.number().optional(),
  seed: z.number().nullish(),
});

export const googleConfig = ImageGenConfig({
  metadataFn: (params) => ({
    engine: 'google',
    baseModel: params.baseModel,
    process: 'txt2img',
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    aspectRatio: params.aspectRatio,
    quantity: params.quantity,
    seed: params.seed,
  }),
  inputFn: ({ params, resources }): Imagen4ImageGenInput => {
    let model = 'imagen4';
    for (const resource of resources) {
      const match = googleModelVersionToModelMap.get(resource.id);
      if (match) model = match;
    }

    return schema.parse({
      engine: params.engine,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      aspectRatio: params.aspectRatio,
      numImages: params.quantity,
      seed: params.seed,
      model,
    });
  },
});
