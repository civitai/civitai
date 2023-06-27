import { ModelType } from '@prisma/client';
import { z } from 'zod';
import { constants } from '~/server/common/constants';
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
  baseModel: z.string().optional(),
  supported: z.boolean().optional(),
});

export type GetGenerationRequestsInput = z.infer<typeof getGenerationRequestsSchema>;
export const getGenerationRequestsSchema = z.object({
  take: z.number().default(10),
  cursor: z.number().optional(),
  status: z.nativeEnum(GenerationRequestStatus).array().optional(),
  requestId: z.number().array().optional(),
});

export type GenerationParamsInput = z.infer<typeof generationParamsSchema>;
export const generationParamsSchema = z.object({
  prompt: z
    .string()
    .nonempty('Prompt cannot be empty')
    .superRefine((val, ctx) => {
      const { blockedFor, success } = auditPrompt(val);
      if (!success)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Blocked for: ${blockedFor.join(', ')}`,
        });
    }),
  negativePrompt: z.string().optional(),
  cfgScale: z.number().min(1).max(30),
  sampler: z.enum(constants.samplers),
  steps: z.number().min(1).max(150),
  seed: z.number().min(-1).max(999999999999999).nullish(),
  clipSkip: z.number().default(1),
  quantity: z.number().max(10),
});

export type CreateGenerationRequestInput = z.infer<typeof createGenerationRequestSchema>;
export const createGenerationRequestSchema = generationParamsSchema.extend({
  resources: z
    .object({
      modelVersionId: z.number(),
      type: z.nativeEnum(ModelType),
      strength: z.number().min(-1).max(2).optional(),
      triggerWord: z.string().optional(),
    })
    .array(),
  height: z.number(),
  width: z.number(),
});

export type CheckResourcesCoverageSchema = z.infer<typeof checkResourcesCoverageSchema>;
export const checkResourcesCoverageSchema = z.object({
  id: z.number(),
});
