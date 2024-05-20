import { z } from 'zod';
import { baseModelSetTypes, generation } from '~/server/common/constants';

export const textToImageParamsSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  cfgScale: z.number(),
  sampler: z.string(),
  seed: z.number(),
  clipSkip: z.number(),
  steps: z.number(),
  quantity: z.number(),
  nsfw: z.boolean().optional(),
  draft: z.boolean().optional(),
  aspectRatio: z.number(),
  baseModel: z.enum(baseModelSetTypes),
});

export const textToImageParamsValidationSchema = textToImageParamsSchema.extend({
  prompt: z
    .string()
    .nonempty('Prompt cannot be empty')
    .max(1500, 'Prompt cannot be longer than 1500 characters'),
  negativePrompt: z.string().max(1000, 'Prompt cannot be longer than 1000 characters').optional(),
  cfgScale: z.coerce.number().min(1).max(30),
  sampler: z
    .string()
    .refine((val) => generation.samplers.includes(val as (typeof generation.samplers)[number]), {
      message: 'invalid sampler',
    }),
  seed: z.coerce.number().min(-1).max(generation.maxValues.seed).default(-1),
  clipSkip: z.coerce.number().default(1),
  steps: z.coerce.number().min(1).max(100),
  quantity: z.coerce.number().min(1).max(20),
  aspectRatio: z.coerce.number(),
});

export const textToImageResourceSchema = z.object({
  id: z.number(),
  strength: z.number().default(1),
  triggerWord: z.string().optional(),
});

export const textToImageResourcesValidatedSchema = textToImageResourceSchema
  .array()
  .min(1, 'You must select at least one resource')
  .max(10);

export const textToImageSchema = z.object({
  whatIf: z.boolean().optional(),
  params: textToImageParamsValidationSchema,
  resources: textToImageResourcesValidatedSchema,
});
