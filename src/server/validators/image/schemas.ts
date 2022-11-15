import { z } from 'zod';

export const imageMetaSchema = z
  .object({
    prompt: z.string(),
    negativePrompt: z.string(),
    cfgScale: z.number(),
    step: z.number(),
    sampler: z.string(),
    seed: z.number(),
  })
  .partial();

export const imageSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  url: z.string(),
  meta: imageMetaSchema.nullish(),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
});

export type ImageUploadProps = z.infer<typeof imageSchema>;
export type ImageMetaProps = z.infer<typeof imageMetaSchema>;
