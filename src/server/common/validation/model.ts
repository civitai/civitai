import { ModelType } from '@prisma/client';
import { z } from 'zod';

export const imageSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  url: z.string(),
  prompt: z.string().nullish(),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
});

export const tagSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  color: z.string().nullish(),
});

export const modelVersionSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: z.string().nullish(),
  url: z.string().url().min(1, 'You must select a file'),
  steps: z.number().nullish(),
  epochs: z.number().nullish(),
  sizeKB: z.number(),
  images: z.array(imageSchema).min(1, 'At least one example image must be uploaded'),
  trainingDataUrl: z.string().nullish(),
});

export const modelSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: z.string().nullish(),
  type: z.nativeEnum(ModelType),
  trainedWords: z.array(z.string()).min(1, 'At least one trained word is required.'),
  tagsOnModels: z.array(tagSchema).nullish(),
  nsfw: z.boolean(),
  modelVersions: z.array(modelVersionSchema).min(1, 'At least one model version is required.'),
});
