import { z } from 'zod';
import { userPreferencesSchema } from '~/server/middleware.trpc';

export type HomeBlockMetaSchema = z.infer<typeof homeBlockMetaSchema>;

export const homeBlockMetaSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    alwaysShowDescription: z.boolean(),
    withIcon: z.boolean(),
    collection: z.object({
      id: z.number(),
      limit: z.number().default(8),
    }),
    leaderboards: z.array(
      z.object({
        id: z.string(),
        index: z.number().default(0),
        // TODO.home-blocks: perhaps we want other useful info here, such as maximum number of places, size of the category, etc.
      })
    ),
    announcements: z.object({
      ids: z.array(z.number()).optional(),
      limit: z.number().optional(),
    }),
    link: z.string(),
    linkText: z.string(),
  })
  .partial();

export type HomeBlockSchema = z.infer<typeof homeBlockSchema>;
export const homeBlockSchema = z.object({
  id: z.number(),
  type: z.string(),
  metadata: homeBlockMetaSchema,
});

export type GetHomeBlocksInputSchema = z.infer<typeof getHomeBlocksInputSchema>;
export const getHomeBlocksInputSchema = z
  .object({
    limit: z.number().default(8),
    dismissed: z.array(z.number()).optional(),
  })
  .merge(userPreferencesSchema)
  .partial()
  .default({ limit: 8 });
