import { z } from 'zod';
import { userPreferencesSchema } from '~/server/middleware.trpc';

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

export type GetHomeBlocksInputSchema = z.infer<typeof getHomeBlocksInputScheme>;
export const getHomeBlocksInputSchema = z
  .object({
    limit: z.number().default(8),
  })
  .merge(userPreferencesSchema)
  .partial();
