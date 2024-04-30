import { ModelType } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';

const textToImageParamsSchema = z.object({
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
  aspectRatio: z.string(),
});

const textToImageResourceSchema = z.object({
  id: z.number(),
  modelId: z.number(),
  modelType: z.nativeEnum(ModelType),
  strength: z.number().default(1),
  triggerWord: z.string().optional(),
});

const textToImageSchema = z.object({
  params: textToImageParamsSchema,
  resources: textToImageResourceSchema,
});

export async function textToImage(
  input: z.infer<typeof textToImageSchema> & { user: SessionUser }
) {
  return;
}
