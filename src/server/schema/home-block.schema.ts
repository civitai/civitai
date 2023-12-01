import { HomeBlockType } from '@prisma/client';
import { z } from 'zod';
import { getByIdSchema } from '~/server/schema/base.schema';

export type HomeBlockMetaSchema = z.infer<typeof homeBlockMetaSchema>;

const socialBlockTypeSchema = z.enum(['ig-reel', 'ig-post', 'yt-short', 'yt-long', 'tw-post']);
const socialBlockSchema = z.object({
  url: z.string().url(),
  type: socialBlockTypeSchema,
});
export type SocialBlockSchema = z.infer<typeof socialBlockSchema>;

export const homeBlockMetaSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    stackedHeader: z.boolean(),
    descriptionAlwaysVisible: z.boolean(),
    withIcon: z.boolean(),
    collection: z.object({
      id: z.number(),
      limit: z.number().default(8),
      rows: z.number().default(2),
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
    event: z.string(),
    socials: z.array(socialBlockSchema),
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
    withCoreData: z.boolean().optional(),
    ownedOnly: z.boolean().optional(),
  })
  .partial()
  .default({ limit: 8 });

export type GetSystemHomeBlocksInputSchema = z.infer<typeof getSystemHomeBlocksInputSchema>;
export const getSystemHomeBlocksInputSchema = z
  .object({
    permanent: z.boolean().optional(),
  })
  .partial();

export type GetHomeBlockByIdInputSchema = z.infer<typeof getHomeBlockByIdInputSchema>;

export const getHomeBlockByIdInputSchema = getByIdSchema.partial();

export type CreateCollectionHomeBlockInputSchema = z.infer<
  typeof createCollectionHomeBlockInputSchema
>;
export const createCollectionHomeBlockInputSchema = z.object({
  collectionId: z.number(),
});

export type UpsertHomeBlockInput = z.infer<typeof upsertHomeBlockInput>;
export const upsertHomeBlockInput = z.object({
  id: z.number().optional(),
  metadata: homeBlockMetaSchema,
  type: z.nativeEnum(HomeBlockType).default(HomeBlockType.Collection),
  sourceId: z.number().optional(),
  index: z.number().optional(),
});

export type SetHomeBlocksOrderInputSchema = z.infer<typeof setHomeBlocksOrderInput>;
export const setHomeBlocksOrderInput = z.object({
  homeBlocks: z.array(
    z.object({
      id: z.number(),
      index: z.number(),
      // Used to clone system home blocks
      userId: z.number().optional(),
    })
  ),
});
