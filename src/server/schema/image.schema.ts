import { z } from 'zod';

const stringToNumber = z.preprocess((value) => Number(value), z.number());

export const imageMetaSchema = z
  .object({
    prompt: z.string(),
    negativePrompt: z.string(),
    cfgScale: stringToNumber,
    steps: stringToNumber,
    sampler: z.string(),
    seed: stringToNumber,
  })
  .partial()
  .passthrough();

export const imageSchema = z.object({
  id: z.number().optional(),
  name: z.string().nullish(),
  url: z.string(),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.keys(value).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
});

export type ImageUploadProps = z.infer<typeof imageSchema>;
export type ImageMetaProps = z.infer<typeof imageMetaSchema> & Record<string, unknown>;
