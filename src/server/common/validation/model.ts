import { ModelFileType, ModelType } from '@prisma/client';
import sanitize from 'sanitize-html';
import { z } from 'zod';

export const imageSchema = z.object({
  id: z.number().optional(),
  name: z.string().nullable(),
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

const sanitizedDescriptionSchema = z.preprocess((val) => {
  if (!val) return null;

  const str = String(val);
  return sanitize(str, {
    allowedTags: ['p', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'br'],
    allowedAttributes: {
      a: ['rel', 'href', 'target'],
    },
    transformTags: {
      a: sanitize.simpleTransform('a', { rel: 'ugc' }),
    },
  });
}, z.string().nullish());

export const fileSchema = z.object({
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.nativeEnum(ModelFileType),
});

export const modelVersionSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: sanitizedDescriptionSchema,
  steps: z.number().nullish(),
  epochs: z.number().nullish(),
  modelFile: fileSchema,
  trainingDataFile: fileSchema.optional(),
  images: z
    .array(imageSchema)
    .min(1, 'At least one example image must be uploaded')
    .max(10, 'You can only upload up to 10 images'),
  trainedWords: z.array(z.string()),
});

export const modelSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: sanitizedDescriptionSchema,
  type: z.nativeEnum(ModelType),
  tagsOnModels: z.array(tagSchema).nullish(),
  nsfw: z.boolean().optional(),
  modelVersions: z.array(modelVersionSchema).min(1, 'At least one model version is required.'),
});
