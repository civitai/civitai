import { z } from 'zod';
import { isProd } from '~/env/other';
import { baseModelSetTypes, generation } from '~/server/common/constants';
import { workflowResourceSchema } from '~/server/schema/orchestrator/workflows.schema';

// #region [step input]
const workflowKeySchema = z.string().default('txt2img');

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
  clipSkip: z.coerce.number().optional(),
  steps: z.coerce.number().min(1).max(100),
  quantity: z.coerce
    .number()
    .max(20)
    .transform((val) => (val <= 0 ? 1 : val)),
  nsfw: z.boolean().default(false),
  draft: z.boolean().default(false),
  aspectRatio: z.string().optional(),
  baseModel: z.enum(baseModelSetTypes),
  width: z.number(),
  height: z.number(),
  // temp props?
  denoise: z.number().max(1).optional(),
  image: z
    .string()
    .startsWith(isProd ? 'https://orchestration.civitai.com' : 'https://orchestration.civitai.com')
    .optional(),
  upscaleWidth: z.number().optional(),
  upscaleHeight: z.number().optional(),
  workflow: workflowKeySchema,
  fluxMode: z.string().optional(),
  experimental: z.boolean().optional(),
});
// #endregion

// #region [step metadata]
// export type ImageCreateParamsMetadata = z.infer<typeof imageCreateParamsMetadataSchema>;
// const imageCreateParamsMetadataSchema = textToImageParamsSchema.partial();

export type TextToImageStepRemixMetadata = z.infer<typeof textToImageStepRemixMetadataSchema>;
export const textToImageStepRemixMetadataSchema = z.object({
  id: z.number(),
  prompt: z.string().optional(),
});

export type TextToImageStepImageMetadata = z.infer<typeof textToImageStepImageMetadataSchema>;
const textToImageStepImageMetadataSchema = z.object({
  hidden: z.boolean().optional(),
  feedback: z.enum(['liked', 'disliked']).optional(),
  comments: z.string().optional(),
  postId: z.number().optional(),
  favorite: z.boolean().optional(),
});

/**
  - images to track comments, feedback, hidden, etc...
  - params is to keep track of the original user input
  - remix to track the id of the resource or image used to initialize the generation
*/
export type GeneratedImageStepMetadata = z.infer<typeof generatedImageStepMetadataSchema>;
export const generatedImageStepMetadataSchema = z.object({
  params: textToImageParamsSchema.optional(),
  resources: workflowResourceSchema.array().optional(),
  remixOfId: z.number().optional(),
  images: z.record(z.string(), textToImageStepImageMetadataSchema).optional(),
});
// #endregion

export const generateImageSchema = z.object({
  params: textToImageParamsSchema,
  resources: workflowResourceSchema.array().min(1, 'You must select at least one resource'),
  tags: z.string().array().default([]),
  remixOfId: z.number().optional(),
  tips: z
    .object({
      creators: z.number().min(0).max(1).default(0).optional(),
      civitai: z.number().min(0).max(1).default(0).optional(),
    })
    .optional(),
});

export const generateImageWhatIfSchema = generateImageSchema.extend({
  resources: z.number().array().min(1),
  params: textToImageParamsSchema.extend({
    prompt: z.string().default('what if'),
    negativePrompt: z.string().optional(),
  }),
});
