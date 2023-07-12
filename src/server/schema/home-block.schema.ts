import { z } from 'zod';

export type HomeBlockMetaSchema = z.infer<typeof homeBlockMetaSchema>;

export const homeBlockMetaSchema = z.object({
  collectionId: z.number().optional(),
  title: z.string(),
  link: z.string(),
  linkText: z.string(),
});
