import { z } from 'zod';
import { userPreferencesSchema } from '~/server/middleware.trpc';

export type HomeBlockMetaSchema = z.infer<typeof homeBlockMetaSchema>;

export const homeBlockMetaSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    collectionId: z.number(),
    leaderboards: z.array(
      z.object({
        id: z.string(),
        // TODO.home-blocks: perhaps we want other useful info here, such as maximum number of places, size of the category, etc.
      })
    ),
    announcements: z.array(
      z.object({
        id: z.number(),
        // TODO.home-blocks: define what props will be needed for announcements. Based off of design, at least colSpan is needed.
        colSpan: z.number().default(12),
      })
    ),
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
    dismissed: z.array(z.number()).optional(),
  })
  .merge(userPreferencesSchema)
  .partial()
  .default({ limit: 8 });
