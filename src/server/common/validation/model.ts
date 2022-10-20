import { ModelType } from '@prisma/client';
import { z } from 'zod';

export const imageSchema = z.object({
  name: z.string(),
  url: z.string(),
  userId: z.number(),
  prompt: z.string().optional(),
  hash: z.string().optional(),
  height: z.string().optional(),
  width: z.string().optional(),
});

export const tagSchema = z.object({
  id: z.number().nullish(),
  name: z.string().min(1, 'Name cannot be empty.'),
  color: z.string().optional(),
});

export const modelVersionSchema = z.object({
  id: z.number().nullish(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: z.string().optional(),
  url: z.string().url().min(1, 'You must select a file'),
  steps: z.number().optional(),
  epochs: z.number().optional(),
  sizeKB: z.number(),
  images: z.array(imageSchema).min(1, 'At least one example image must be uploaded'),
  trainingDataUrl: z.string().optional(),
});

export const modelSchema = z.object({
  id: z.number().nullish(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: z.string().optional(),
  type: z.nativeEnum(ModelType),
  trainedWords: z.array(z.string()).min(1, 'At least one trained word is required.'),
  tags: z.array(z.string()).optional(),
  nsfw: z.boolean(),
  modelVersions: z.array(modelVersionSchema).min(1, 'At least one model version is required.'),
});
