import { ModelType } from '@prisma/client';
import { z } from 'zod';
import { BaseModel, Sampler, constants } from '~/server/common/constants';
import { GenerationRequestStatus } from '~/server/services/generation/generation.types';
import { auditPrompt } from '~/utils/image-metadata';

// export type GetGenerationResourceInput = z.infer<typeof getGenerationResourceSchema>;
// export const getGenerationResourceSchema = z.object({
//   type: z.nativeEnum(ModelType),
//   name: z.string(),
// });

export type GetGenerationResourcesInput = z.infer<typeof getGenerationResourcesSchema>;
export const getGenerationResourcesSchema = z.object({
  take: z.number().default(10),
  query: z.string().optional(),
  types: z.nativeEnum(ModelType).array().optional(),
  notTypes: z.nativeEnum(ModelType).array().optional(),
  ids: z.number().array().optional(),
  baseModel: z
    .string()
    .refine((val) => constants.baseModels.includes(val as BaseModel))
    .optional(),
  supported: z.boolean().optional(),
});

export type GetGenerationRequestsInput = z.input<typeof getGenerationRequestsSchema>;
export type GetGenerationRequestsOutput = z.output<typeof getGenerationRequestsSchema>;
export const getGenerationRequestsSchema = z.object({
  take: z.number().default(10),
  cursor: z.number().optional(),
  status: z.nativeEnum(GenerationRequestStatus).array().optional(),
  requestId: z.number().array().optional(),
});

export const supportedSamplers = constants.samplers.filter((sampler) =>
  ['Euler a', 'Euler', 'Heun', 'LMS', 'DDIM', 'DPM++ 2M Karras', 'DPM2', 'DPM2 a'].includes(sampler)
);

const MAX_SEED = 4294967295;
export const seedSchema = z.coerce.number().min(-1).max(MAX_SEED).default(-1);
export const generationParamsSchema = z.object({
  prompt: z
    .string()
    .nonempty('Prompt cannot be empty')
    .max(1500, 'Prompt cannot be longer than 1000 characters')
    .superRefine((val, ctx) => {
      const { blockedFor, success } = auditPrompt(val);
      if (!success)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Blocked for: ${blockedFor.join(', ')}`,
        });
    }),
  negativePrompt: z.string().max(1000, 'Prompt cannot be longer than 1000 characters').optional(),
  cfgScale: z.coerce.number().min(1).max(30),
  sampler: z
    .string()
    .refine((val) => supportedSamplers.includes(val as Sampler), { message: 'invalid sampler' }),
  steps: z.coerce.number().min(1).max(150),
  seed: seedSchema,
  clipSkip: z.coerce.number().default(1),
  quantity: z.coerce.number().max(10),
  height: z.number(),
  width: z.number(),
  nsfw: z.boolean().optional(),
  vae: z.number().optional(),
});

export const generationResourceSchema = z.object({
  id: z.number(),
  name: z.string(),
  trainedWords: z.string().array(),
  modelId: z.number(),
  modelName: z.string(),
  modelType: z.nativeEnum(ModelType),

  // navigation props
  covered: z.boolean().optional(),
  baseModel: z.string(),
});

export const additionalResourceLimit = 10;
export type CreateGenerationRequestInput = z.infer<typeof createGenerationRequestSchema>;
export const createGenerationRequestSchema = z.object({
  resources: z
    .object({
      id: z.number(),
      modelType: z.nativeEnum(ModelType),
      strength: z.number().min(-1).max(2).optional(),
      triggerWord: z.string().optional(),
    })
    .array()
    .max(additionalResourceLimit),
  params: generationParamsSchema,
});

export type CheckResourcesCoverageSchema = z.infer<typeof checkResourcesCoverageSchema>;
export const checkResourcesCoverageSchema = z.object({
  id: z.number(),
});

export type GetGenerationDataInput = z.infer<typeof getGenerationDataSchema>;
export const getGenerationDataSchema = z.object({
  id: z.number(),
  type: z.enum(['image', 'model']),
});

export type BulkDeleteGeneratedImagesInput = z.infer<typeof bulkDeleteGeneratedImagesSchema>;
export const bulkDeleteGeneratedImagesSchema = z.object({
  ids: z.number().array(),
});
