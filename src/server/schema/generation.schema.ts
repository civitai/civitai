import { ModelType } from '@prisma/client';
import { z } from 'zod';
import { GenerationRequestStatus } from '~/server/services/generation/generation.types';

// export type GetGenerationResourceInput = z.infer<typeof getGenerationResourceSchema>;
// export const getGenerationResourceSchema = z.object({
//   type: z.nativeEnum(ModelType),
//   name: z.string(),
// });

export type GetGenerationResourcesInput = z.infer<typeof getGenerationResourcesSchema>;
export const getGenerationResourcesSchema = z.object({
  take: z.number().default(10),
  query: z.string(),
  types: z.nativeEnum(ModelType).array().optional(),
  notTypes: z.nativeEnum(ModelType).array().optional(),
  ids: z.number().array().optional(),
});

export type GetGenerationRequestsInput = z.infer<typeof getGenerationRequestsSchema>;
export const getGenerationRequestsSchema = z.object({
  take: z.number().default(10),
  cursor: z.number().optional(),
  status: z.nativeEnum(GenerationRequestStatus).array().optional(),
});

export type GenerationParamsInput = z.infer<typeof generationParamsSchema>;
export const generationParamsSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  cfgScale: z.number().min(1).max(30),
  sampler: z.string(),
  steps: z.number().min(1).max(150),
  seed: z.number().optional(),
  clipSkip: z.number().default(1),
  quantity: z.number(),
});

export type CreateGenerationRequestInput = z.infer<typeof createGenerationRequestSchema>;
export const createGenerationRequestSchema = generationParamsSchema.extend({
  resources: z
    .object({
      modelVersionId: z.number(),
      type: z.nativeEnum(ModelType),
      strength: z.number().min(-1).max(2).optional(),
    })
    .array(),
  height: z.number(),
  width: z.number(),
});

export type GetGenerationImagesInput = z.infer<typeof getGenerationImagesSchema>;
export const getGenerationImagesSchema = z.object({
  take: z.number().default(10),
  cursor: z.number().optional(),
});
