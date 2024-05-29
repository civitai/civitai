import { z } from 'zod';
import { baseModelSetTypes, generation } from '~/server/common/constants';
import { stripChecksAndEffects } from '~/utils/zod-helpers';

export const textToImageParamsSchema = z.object({
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
  seed: z.coerce.number().min(0).max(generation.maxValues.seed).optional(),
  clipSkip: z.coerce.number().default(1),
  steps: z.coerce.number().min(1).max(100),
  quantity: z.coerce.number().min(1).max(20),
  nsfw: z.boolean().optional(),
  draft: z.boolean().optional(),
  aspectRatio: z.string(),
  baseModel: z.enum(baseModelSetTypes),
});

export const textToImageResourceSchema = z.object({
  id: z.number(),
  strength: z.number().default(1),
});

export const textToImageWhatIfSchema = stripChecksAndEffects(textToImageParamsSchema).extend({
  resources: z.number().array().min(1),
});

export const textToImageSchema = z.object({
  params: textToImageParamsSchema,
  resources: textToImageResourceSchema.array().min(1, 'You must select at least one resource'),
});
