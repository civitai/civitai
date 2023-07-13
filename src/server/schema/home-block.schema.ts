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

export type GetHomeBlocksInputSchema = z.infer<typeof getHomeBlocksInputSchema>;
export const getHomeBlocksInputSchema = z
  .object({
    // TODO.home-blocks
    // Need to define a block limit AND a block-"items"-limit
    limit: z.number().default(8),
  })
  .merge(userPreferencesSchema)
  .partial()
  .default({ limit: 8 });
