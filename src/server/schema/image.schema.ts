import { z } from 'zod';

export const imageMetaSchema = z
  .object({
    prompt: z.string(),
    negativePrompt: z.string(),
    cfgScale: z.preprocess((value) => Number(value), z.number()),
    steps: z.preprocess((value) => Number(value), z.number()),
    sampler: z.string(),
    seed: z.preprocess((value) => Number(value), z.number()),
  })
  .partial()
  .passthrough();

export const imageSchema = z.object({
  id: z.number().optional(),
  name: z.string().nullish(),
  url: z.string(),
  meta: imageMetaSchema.nullish(),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
});

export type ImageUploadProps = z.infer<typeof imageSchema>;
export type ImageMetaProps = z.infer<typeof imageMetaSchema> & Record<string, unknown>;
