import { ModelType } from '~/shared/utils/prisma/enums';
import { z } from 'zod';
import { BaseModel, constants, generation } from '~/server/common/constants';
import { userTierSchema } from '~/server/schema/user.schema';
import { auditPrompt } from '~/utils/metadata/audit';
import { imageSchema } from './image.schema';
import { GenerationRequestStatus } from '~/server/common/enums';
import { booleanString, numericStringArray } from '~/utils/zod-helpers';
import { modelVersionEarlyAccessConfigSchema } from '~/server/schema/model-version.schema';
// export type GetGenerationResourceInput = z.infer<typeof getGenerationResourceSchema>;
// export const getGenerationResourceSchema = z.object({
//   type: z.nativeEnum(ModelType),
//   name: z.string(),
// });

export type GetGenerationResourcesInput = z.infer<typeof getGenerationResourcesSchema>;
export const getGenerationResourcesSchema = z.object({
  limit: z.number().default(10),
  page: z.number().default(1),
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
  detailed: z.boolean().optional(),
});

const generationResourceSchemaBase = z.object({
  id: z.number(),
  strength: z.number().default(1),
  name: z.string(),
  trainedWords: z.string().array().default([]),
  baseModel: z.string(),
  earlyAccessEndsAt: z.coerce.date().optional(),
  earlyAccessConfig: modelVersionEarlyAccessConfigSchema.optional(),
  canGenerate: z.boolean(),
  minStrength: z.number().default(-1),
  maxStrength: z.number().default(2),
  image: imageSchema.pick({ url: true }).optional(),
  covered: z.boolean(),
  hasAccess: z.boolean(),
  additionalResourceCost: z.boolean().optional(),
});
export type GenerationResourceSchema = z.infer<typeof generationResourceSchema>;
export const generationResourceSchema = generationResourceSchemaBase.extend({
  model: z.object({
    id: z.number(),
    name: z.string(),
    type: z.nativeEnum(ModelType),
    nsfw: z.boolean().optional(),
    poi: z.boolean().optional(),
    minor: z.boolean().optional(),
  }),
  substitute: generationResourceSchemaBase.optional(),
});

const baseGenerationParamsSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  cfgScale: z.coerce.number(),
  sampler: z.string(),
  seed: z.coerce.number(),
  steps: z.coerce.number(),
  clipSkip: z.coerce.number(),
  quantity: z.coerce.number(),
  nsfw: z.boolean().optional(),
  aspectRatio: z.string(),
  draft: z.boolean().optional(),
});

export const blockedRequest = (() => {
  let instances: number[] = [];
  const updateStorage = () => {
    localStorage.setItem('brc', JSON.stringify(instances));
  };
  const increment = () => {
    instances.push(Date.now());
    updateStorage();
    return instances.length;
  };
  const status = () => {
    const count = instances.length;
    if (count > constants.imageGeneration.requestBlocking.muted) return 'muted';
    if (count > constants.imageGeneration.requestBlocking.notified) return 'notified';
    if (count > constants.imageGeneration.requestBlocking.warned) return 'warned';
    return 'ok';
  };
  if (typeof window !== 'undefined') {
    const storedInstances = JSON.parse(localStorage.getItem('brc') ?? '[]');
    const cutOff = Date.now() - 1000 * 60 * 60 * 24;
    instances = storedInstances.filter((x: number) => x > cutOff);
    updateStorage();
  }

  return {
    status,
    increment,
  };
})();

function promptAuditRefiner(
  data: { prompt: string; negativePrompt?: string },
  ctx: z.RefinementCtx
) {
  const { blockedFor, success } = auditPrompt(data.prompt); // TODO: re-enable negativePrompt here
  if (!success) {
    let message = `Blocked for: ${blockedFor.join(', ')}`;
    const count = blockedRequest.increment();
    const status = blockedRequest.status();
    if (status === 'warned') {
      message += `. If you continue to attempt blocked prompts, your account will be sent for review.`;
    } else if (status === 'notified') {
      message += `. Your account has been sent for review. If you continue to attempt blocked prompts, your generation permissions will be revoked.`;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prompt'],
      message,
      params: { count },
    });
  }
}

const sharedGenerationParamsSchema = z.object({
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
  nsfw: z.boolean().optional(),
  draft: z.boolean().optional(),
  staging: z.boolean().optional(),
  baseModel: z.string().optional(),
  aspectRatio: z.string(),
});

const generationLimitsSchema = z.object({
  quantity: z.number(),
  queue: z.number(),
  steps: z.number(),
  resources: z.number(),
});
export type GenerationLimits = z.infer<typeof generationLimitsSchema>;
export const defaultsByTier: Record<string, GenerationLimits> = {
  free: {
    quantity: 4,
    queue: 4,
    steps: 40,
    resources: 9,
  },
  founder: {
    quantity: 8,
    queue: 8,
    steps: 60,
    resources: 9,
  },
  bronze: { quantity: 8, queue: 8, steps: 60, resources: 12 },
  silver: { quantity: 10, queue: 10, steps: 60, resources: 12 },
  gold: { quantity: 12, queue: 10, steps: 60, resources: 12 },
};

export const generationStatusSchema = z.object({
  available: z.boolean().default(true),
  message: z.string().nullish(),
  minorFallback: z.boolean().default(true),
  sfwEmbed: z.boolean().default(true),
  limits: z
    .record(userTierSchema, generationLimitsSchema.partial())
    .default(defaultsByTier)
    .transform((limits) => {
      // Merge each tier with its defaults
      const mergedLimits = { ...defaultsByTier };
      for (const tier of userTierSchema.options) {
        mergedLimits[tier] = { ...mergedLimits[tier], ...limits[tier] };
      }
      return mergedLimits;
    }),
  charge: z.boolean().default(true),
  checkResourceAvailability: z.boolean().default(false),
  membershipPriority: z.boolean().default(false),
});
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const generationFormShapeSchema = baseGenerationParamsSchema.extend({
  model: generationResourceSchema,
  resources: generationResourceSchema.array(),
  vae: generationResourceSchema.optional(),
  aspectRatio: z.string(),
});

export type GenerateFormModel = z.infer<typeof generateFormSchema>;
export const generateFormSchema = generationFormShapeSchema
  .merge(sharedGenerationParamsSchema)
  .extend({
    model: generationResourceSchema,
    resources: generationResourceSchema.array().default([]),
    vae: generationResourceSchema.optional(),
    tier: userTierSchema.optional().default('free'),
    creatorTip: z.number().min(0).max(1).optional(),
    civitaiTip: z.number().min(0).max(1).optional(),
  })
  .superRefine(promptAuditRefiner)
  .refine(
    (data) => {
      // Check if resources are at limit based on tier
      const { resources, tier } = data;
      const limit = defaultsByTier[tier].resources;

      return resources.length <= limit;
    },
    { message: `You have exceed the number of allowed resources`, path: ['resources'] }
  );

export type CreateGenerationRequestInput = z.infer<typeof createGenerationRequestSchema>;
export const createGenerationRequestSchema = z.object({
  resources: z
    .object({
      id: z.number(),
      modelType: z.nativeEnum(ModelType),
      strength: z.number().default(1),
      triggerWord: z.string().optional(),
    })
    .array()
    .min(1, 'You must select at least one resource'),
  params: sharedGenerationParamsSchema.superRefine(promptAuditRefiner),
});

export type GenerationRequestTestRunSchema = z.infer<typeof generationRequestTestRunSchema>;
export const generationRequestTestRunSchema = z.object({
  model: z.number().nullish(),
  baseModel: z.string().optional(),
  aspectRatio: z.string(),
  steps: z.coerce.number().min(1).max(100),
  quantity: z.coerce.number().min(1).max(20),
  sampler: z
    .string()
    .refine((val) => generation.samplers.includes(val as (typeof generation.samplers)[number]), {
      message: 'invalid sampler',
    }),
  resources: z.number().array().nullish(),
  draft: z.boolean().optional(),
  creatorTip: z.number().min(0).max(1).optional(),
  civitaiTip: z.number().min(0).max(1).optional(),
});
export type CheckResourcesCoverageSchema = z.infer<typeof checkResourcesCoverageSchema>;
export const checkResourcesCoverageSchema = z.object({
  id: z.number(),
});

const baseSchema = z.object({ generation: booleanString().default(true) });
export type GetGenerationDataInput = z.input<typeof getGenerationDataSchema>;
export type GetGenerationDataSchema = z.infer<typeof getGenerationDataSchema>;
export const getGenerationDataSchema = z.discriminatedUnion('type', [
  baseSchema.extend({ type: z.literal('image'), id: z.coerce.number() }),
  baseSchema.extend({ type: z.literal('video'), id: z.coerce.number() }),
  baseSchema.extend({ type: z.literal('audio'), id: z.coerce.number() }),
  baseSchema.extend({ type: z.literal('modelVersion'), id: z.coerce.number() }),
  baseSchema.extend({
    type: z.literal('modelVersions'),
    ids: z
      .union([z.array(z.coerce.number()), z.coerce.number()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  }),
]);

export type BulkDeleteGeneratedImagesInput = z.infer<typeof bulkDeleteGeneratedImagesSchema>;
export const bulkDeleteGeneratedImagesSchema = z.object({
  ids: z.number().array(),
  cancelled: z.boolean().optional(),
});

export type PrepareModelInput = z.infer<typeof prepareModelSchema>;
export const prepareModelSchema = z.object({
  id: z.number(),
});
