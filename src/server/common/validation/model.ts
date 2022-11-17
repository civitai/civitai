import { ModelFileType, ModelStatus, ModelType } from '@prisma/client';
import { sanitizeHtml } from '~/utils/html-helpers';
import { z } from 'zod';
import { imageSchema } from '~/server/schema/image.schema';

// export const imageSchema = z.object({
//   id: z.number().optional(),
//   name: z.string().nullable(),
//   url: z.string(),
//   meta: z.object(),
//   hash: z.string().nullish(),
//   height: z.number().nullish(),
//   width: z.number().nullish(),
// });

export const tagSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  color: z.string().nullish(),
});

const sanitizedDescriptionSchema = z.preprocess((val) => {
  if (!val) return null;

  const str = String(val);
  return sanitizeHtml(str);
}, z.string().nullish());

export const fileSchema = z.object({
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.nativeEnum(ModelFileType),
});

export type FileProps = z.infer<typeof fileSchema>;

export const modelVersionSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: sanitizedDescriptionSchema,
  steps: z.number().nullish(),
  epochs: z.number().nullish(),
  modelFile: fileSchema,
  trainingDataFile: fileSchema.nullish(),
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
  status: z.nativeEnum(ModelStatus),
  tagsOnModels: z.array(tagSchema).nullish(),
  nsfw: z.boolean().optional(),
  modelVersions: z.array(modelVersionSchema).min(1, 'At least one model version is required.'),
});
