import { z } from 'zod';

export const imageMetaSchema = z.object({
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  gscale: z.number().optional(),
});

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
