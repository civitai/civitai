import * as z from 'zod';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  DomainColor,
  HomeBlockType,
  MediaType,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

export type HomeBlockMetaSchema = z.infer<typeof homeBlockMetaSchema>;

const socialBlockTypeSchema = z.enum(['ig-reel', 'ig-post', 'yt-short', 'yt-long', 'tw-post']);
const socialBlockSchema = z.object({
  url: z.url(),
  type: socialBlockTypeSchema,
});
export type SocialBlockSchema = z.infer<typeof socialBlockSchema>;

const cosmeticShopSectionSchema = z.object({
  id: z.number(),
  maxItems: z.number().optional(),
});

export type AutoFeatureSchema = z.infer<typeof autoFeatureSchema>;
/**
 * Config for the job that tops the Featured Images collection up from the featured pool.
 * Lives on the FeaturedCollections block so it can be tuned through the admin home-block
 * endpoints instead of a deploy — including `intervalHours`, which is why the job's own cron
 * is hourly rather than the real cadence.
 */
export const autoFeatureSchema = z.object({
  collectionId: z.number().int().positive(),
  dryRun: z.boolean().default(true),
  perRun: z.number().int().min(1).max(50).default(5),
  intervalHours: z.number().min(1).max(168).default(6),
  windowDays: z.number().int().min(1).max(90).default(7),
  // How far back the per-creator and per-collection caps count previous auto-features.
  // Separate from `windowDays` on purpose: that one decides which images are fresh enough to
  // be candidates, and tuning a cap through this config must not silently change what the job
  // considers recent. Defaults to 7, the value `windowDays` shipped with, so splitting them
  // changes nothing until someone deliberately moves one.
  //
  // Worth knowing before tuning either: while they were one value, widening the candidate pool
  // also lengthened the cap window, so a bigger pool automatically tightened per-creator
  // repeats. That accidental brake is gone. Raising `windowDays` alone now widens the pool and
  // leaves the cap counting over 7 days, which permits more repeats per creator than the same
  // edit used to.
  capWindowDays: z.number().int().min(1).max(365).default(7),
  recencyOffsetHours: z.number().min(0).max(720).default(12),
  decayExponent: z.number().min(0).max(3).default(0.8),
  maxPerCreatorPerRun: z.number().int().min(1).max(50).default(1),
  maxPerCreatorInWindow: z.number().int().min(1).max(50).default(2),
  maxPerCollectionInWindow: z.number().int().min(1).max(500).optional(),
  minReactions: z.number().int().min(0).default(0),
  // `global` scores every candidate together, which lets the busiest collection dominate
  // (measured: 17 of 40 slots). Kept selectable so that can be re-tested without a deploy.
  strategy: z.enum(['round-robin', 'global']).default('round-robin'),
});

export const homeBlockMetaSchema = z
  .object({
    title: z.string(),
    description: getSanitizedStringSchema(),
    stackedHeader: z.boolean(),
    descriptionAlwaysVisible: z.boolean(),
    withIcon: z.boolean(),
    collection: z.object({
      id: z.number(),
      limit: z.number().default(8),
      rows: z.number().default(2),
      tagId: z.coerce.number().optional(),
      // Caps how many items from the same creator can appear in one homeblock render.
      // Pair with a fetch `limit` larger than `rows * 7` so the dedup has a pool to pick from.
      maxPerUser: z.number().int().positive().optional(),
    }),
    leaderboards: z.array(
      z.object({
        id: z.string(),
        index: z.number().default(0),
        // Where the card's "More" button goes. Defaults to the board's own page;
        // the new-creator boards point at their pre-filtered feed instead, since
        // browsing those creators' work is the point rather than the ranking.
        moreHref: z.string().optional(),
        // TODO.home-blocks: perhaps we want other useful info here, such as maximum number of places, size of the category, etc.
      })
    ),
    // Generic feed slice: run one of the existing feeds under saved filters and render
    // the result like a Collection block. Filters are an explicit allowlist rather than
    // a passthrough of the feed input — home-block metadata is mod-editable, and a
    // passthrough would let a config change reach every knob those services expose.
    feed: z.object({
      entity: z.enum(['images', 'models']),
      limit: z.number().int().min(1).max(100).default(28),
      rows: z.number().int().min(1).max(4).default(2),
      maxPerUser: z.number().int().positive().optional(),
      sort: z.string().optional(),
      period: z.enum(MetricTimeframe).optional(),
      newCreators: z.boolean().optional(),
      // Home-page content is not human-reviewed before it lands there, so a Feed
      // block defaults to PG only rather than the PG+PG13 the feeds themselves use.
      // Set 'sfw' to opt a block back up to PG-13.
      browsingLevel: z.enum(['public', 'sfw']).optional(),
      // images only
      types: z.array(z.enum(MediaType)).optional(),
      // models only
      baseModels: z.array(z.string()).optional(),
    }),
    announcements: z.object({
      ids: z.array(z.number()).optional(),
      limit: z.number().optional(),
    }),
    event: z.string(),
    socials: z.array(socialBlockSchema),
    link: z.string(),
    linkText: z.string(),
    cosmeticShopSection: cosmeticShopSectionSchema,
    featuredCollections: z.object({
      collectionIds: z.array(z.number()).default([]),
      // Fetch pool per rendered collection, ceilinged at getAllCollectionItemsSchema's max.
      limit: z.number().int().min(1).max(100).default(100),
      rows: z.number().int().min(1).max(4).default(2),
      renderCount: z.number().int().min(1).max(10).default(3),
      // Per-curator cap inside each rendered collection, same knob Collection blocks have.
      // 0 opts a block out; unset falls back to FEATURED_COLLECTIONS_DEFAULTS.maxPerUser.
      maxPerUser: z.number().int().min(0).max(50).optional(),
      maxStaleDays: z.number().int().min(1).max(365).optional(),
      minRecentItems: z.number().int().min(1).max(100).optional(),
      nameSnapshots: z.record(z.string(), z.string()).default({}),
      writeSnapshots: z.record(z.string(), z.string()).default({}),
      autoFeature: autoFeatureSchema.optional(),
    }),
    footer: z.string().optional(),
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
    excludedSystemHomeBlockIds: z.array(z.number()).optional(),
    systemHomeBlockIds: z.array(z.number()).optional(),
  })
  .partial()
  .default({ limit: 8 });

export type GetSystemHomeBlocksInputSchema = z.infer<typeof getSystemHomeBlocksInputSchema>;
export const getSystemHomeBlocksInputSchema = z
  .object({
    permanent: z.boolean().optional(),
    excludedSystemHomeBlockIds: z.array(z.number()).optional(),
    systemHomeBlockIds: z.array(z.number()).optional(),
  })
  .partial();

export type GetHomeBlockByIdInputSchema = z.infer<typeof getHomeBlockByIdInputSchema>;

export const getHomeBlockByIdInputSchema = getByIdSchema
  .partial()
  .extend({ domain: z.enum(DomainColor).optional() });

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
  type: z.enum(HomeBlockType).default(HomeBlockType.Collection),
  sourceId: z.number().optional(),
  index: z.number().optional(),
});

export type ToggleFeaturedCollectionInputSchema = z.infer<
  typeof toggleFeaturedCollectionInputSchema
>;
export const toggleFeaturedCollectionInputSchema = z.object({
  collectionId: z.number(),
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
