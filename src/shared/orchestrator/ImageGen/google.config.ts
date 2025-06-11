import type { Imagen4ImageGenInput } from '@civitai/client';
import { z } from 'zod';
import type { BaseModelSetType } from '~/server/common/constants';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

export const imagen4AspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;

type GoogleModel = (typeof googleModels)[number];
export const googleModels = ['imagen4'] as const;

const baseModelToModelMap = {
  Imagen4: 'imagen4',
} as Record<BaseModelSetType, GoogleModel>;

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
  inputFn: ({ params }): Imagen4ImageGenInput =>
    schema.parse({
      engine: params.engine,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      aspectRatio: params.aspectRatio ? imagen4AspectRatios[Number(params.aspectRatio)] : undefined,
      numImages: params.quantity,
      seed: params.seed,
      model: baseModelToModelMap[params.baseModel],
    }),
});
