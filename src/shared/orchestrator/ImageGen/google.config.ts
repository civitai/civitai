import type { Imagen4ImageGenInput } from '@civitai/client';
import { z } from 'zod';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

export const imagen4AspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;

type GoogleModel = (typeof googleModels)[number];
export const googleModels = ['imagen4'] as const;

const modelVersionToModelMap = new Map<number, GoogleModel>([[1889632, 'imagen4']]);

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
    process: 'txt2img',
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    aspectRatio: params.aspectRatio,
    quantity: params.quantity,
    seed: params.seed,
    baseModel: params.baseModel,
  }),
  inputFn: ({ params, resources }): Imagen4ImageGenInput => {
    let model = 'imagen4';
    for (const resource of resources) {
      const match = modelVersionToModelMap.get(resource.id);
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
