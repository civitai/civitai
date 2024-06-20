import { z } from 'zod';
import { baseModelSetTypes, generation } from '~/server/common/constants';
import { stripChecksAndEffects } from '~/utils/zod-helpers';

// #region [step input]
export type TextToImageParams = z.infer<typeof textToImageParamsSchema>;
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
// #endregion

// #region [step metadata]
export type TextToImageStepParamsMetadata = z.infer<typeof textToImageStepParamsMetadataSchema>;
const textToImageStepParamsMetadataSchema = z.object({
  nsfw: z.boolean().optional(),
  draft: z.boolean().optional(),
  steps: z.number().optional(),
  cfgScale: z.number().optional(),
  sampler: z.string().optional(),
});

export type TextToImageStepRemixMetadata = z.infer<typeof textToImageStepRemixMetadataSchema>;
const textToImageStepRemixMetadataSchema = z.object({
  versionId: z.number().optional(),
  imageId: z.number().optional(),
});

export type TextToImageStepImageMetadata = z.infer<typeof textToImageStepImageMetadataSchema>;
const textToImageStepImageMetadataSchema = z.object({
  hidden: z.boolean().optional(),
  feedback: z.enum(['liked', 'disliked']).optional(),
  comments: z.string().optional(),
});

/**
  - params is to keep track of properties that are potentially lost when submitting generation data.
  - remix to track the id of the resource or image used to initialize the generation
  - images to track comments, feedback, hidden, etc...
*/
export type TextToImageStepMetadata = z.infer<typeof textToImageStepMetadataSchema>;
export const textToImageStepMetadataSchema = z.object({
  params: textToImageStepParamsMetadataSchema.optional(),
  remix: textToImageStepRemixMetadataSchema.optional(),
  images: z.record(z.string(), textToImageStepImageMetadataSchema).optional(),
});
// #endregion

export const textToImageCreateSchema = z.object({
  params: textToImageParamsSchema,
  resources: textToImageResourceSchema.array().min(1, 'You must select at least one resource'),
  tags: z.string().array().default([]),
  metadata: textToImageStepMetadataSchema.optional(),
});
