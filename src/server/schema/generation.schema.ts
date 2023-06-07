import { ModelType } from '@prisma/client';
import { z } from 'zod';

// export type GetGenerationResourceInput = z.infer<typeof getGenerationResourceSchema>;
// export const getGenerationResourceSchema = z.object({
//   type: z.nativeEnum(ModelType),
//   name: z.string(),
// });

export type GetGenerationResourcesInput = z.infer<typeof getGenerationResourcesSchema>;
export const getGenerationResourcesSchema = z.object({
  take: z.number().default(10),
  query: z.string(),
  type: z.nativeEnum(ModelType).optional(),
  ids: z.number().array().optional(),
});

export type GetGenerationRequestsInput = z.infer<typeof getGenerationRequestsSchema>;
export const getGenerationRequestsSchema = z.object({
  take: z.number().default(10),
  cursor: z.string().optional(),
  status: z.enum(['Pending', 'Succeeded', 'Failed', 'Canceled']),
});

export type GenerationParamsInput = z.infer<typeof generationParamsSchema>;
export const generationParamsSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  cfgScale: z.number(),
  sampler: z.string(),
  steps: z.number(),
  seed: z.number(),
  clipSkip: z.number(),
  quantity: z.number(),
});

export type CreateGenerationRequestInput = z.infer<typeof createGenerationRequestSchema>;
export const createGenerationRequestSchema = generationParamsSchema.extend({
  resources: z
    .object({
      modelVersionId: z.number(),
      type: z.nativeEnum(ModelType),
      strength: z.number().optional(),
    })
    .array(),
  height: z.number(),
  width: z.number(),
});
