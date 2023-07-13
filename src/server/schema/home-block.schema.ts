import { z } from 'zod';

export type HomeBlockMetaSchema = z.infer<typeof homeBlockMetaSchema>;

export const homeBlockMetaSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    collectionId: z.number(),
    leaderboards: z.string().array(),
    link: z.string(),
    linkText: z.string(),
  })
  .partial();
