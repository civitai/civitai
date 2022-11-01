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

export type ImageUploadProps = z.infer<typeof imageSchema>;
