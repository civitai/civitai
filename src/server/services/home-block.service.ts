import type { Prisma } from '@prisma/client';
import type { SessionUser } from '~/types/session';
import { CacheTTL } from '~/server/common/constants';
import { ImageSort, ModelSort } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  GetHomeBlockByIdInputSchema,
  GetHomeBlocksInputSchema,
  GetSystemHomeBlocksInputSchema,
  HomeBlockMetaSchema,
  SetHomeBlocksOrderInputSchema,
  UpsertHomeBlockInput,
} from '~/server/schema/home-block.schema';
import type { ImageInclude } from '~/server/schema/image.schema';
import type { getCurrentAnnouncements } from '~/server/services/announcement.service';
import {
  getCollectionById,
  getCollectionItemsByCollectionId,
} from '~/server/services/collection.service';
import { getShopSectionsWithItems } from '~/server/services/cosmetic-shop.service';
import { getAllImagesIndex } from '~/server/services/image.service';
import { getHomeBlockCached } from '~/server/services/home-block-cache.service';
import { getLeaderboardsWithResults } from '~/server/services/leaderboard.service';
import type { GetModelsWithImagesAndModelVersions } from '~/server/services/model.service';
import {
  getFeaturedModels,
  getModelsWithImagesAndModelVersions,
} from '~/server/services/model.service';
import {
  computeFeaturedCollectionsState,
  getFeaturedCollectionsState,
} from '~/server/jobs/refresh-featured-collections-eligibility';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { GET_ALL_IMAGES_PER_MODEL_SLIM } from '~/server/utils/model-getall-images';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  allBrowsingLevelsFlag,
  hasSafeBrowsingLevel,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { HOME_BLOCK_ITEMS_PER_ROW } from '~/shared/constants/home-block.constants';
import { HomeBlockType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

const homeBlockSelect = {
  id: true,
  metadata: true,
  type: true,
  userId: true,
  sourceId: true,
  index: true,
} as const;

export const getHomeBlocks = async ({
  userId,
  ownedOnly,
  ids,
  includeSource = false,
}: {
  userId?: number;
  ownedOnly?: boolean;
  ids?: number[];
  includeSource?: boolean;
}) => {
  const hasCustomHomeBlocks = await userHasCustomHomeBlocks(userId);

  if (ownedOnly && !userId) {
    throw throwBadRequestError('You must be logged in to view your home blocks.');
  }

  if (!hasCustomHomeBlocks && !ownedOnly && !ids) {
    return getSystemHomeBlocks({ input: {} });
  }

  const select = {
    ...homeBlockSelect,
    ...(includeSource && { source: { select: { userId: true } } }),
  };

  // The editor's seed. Permanent blocks are unioned in for everyone and cannot be reordered or
  // removed, so offering them here gives the user controls that silently do nothing — and for a
  // user with no rows yet this branch reads back the SYSTEM blocks (userId -1 below), which is
  // how a clone of a permanent block got written in the first place.
  const excludePermanent: Prisma.HomeBlockWhereInput = {
    permanent: false,
    OR: [{ sourceId: null }, { source: { permanent: false } }],
  };

  const where: Prisma.HomeBlockWhereInput = ownedOnly
    ? { userId, ...excludePermanent }
    : { id: ids ? { in: ids } : undefined };

  const userBlocks = await dbRead.homeBlock.findMany({
    select,
    orderBy: { index: { sort: 'asc', nulls: 'last' } },
    where: { ...where, userId: hasCustomHomeBlocks ? userId : -1 },
  });

  if (ownedOnly || ids) return userBlocks;

  // Fetch permanent blocks through cache since they rarely change
  const permanentBlocks = await fetchThroughCache(
    REDIS_KEYS.CACHES.HOME_BLOCKS_PERMANENT,
    async () =>
      dbRead.homeBlock.findMany({
        select,
        orderBy: { index: { sort: 'asc', nulls: 'last' } },
        where: { permanent: true },
      }),
    { ttl: CacheTTL.day }
  );

  // A clone carries its own row id, so dedupe by id can't see that it and the permanent block
  // below are the same block — drop clones of permanent blocks before the union or both render.
  const permanentIds = new Set(permanentBlocks.map((b) => b.id));
  const ownBlocks = userBlocks.filter((b) => !b.sourceId || !permanentIds.has(b.sourceId));

  // Combine and deduplicate - user blocks take precedence over permanent
  const blockMap = new Map(ownBlocks.map((b) => [b.id, b]));
  for (const block of permanentBlocks) {
    if (!blockMap.has(block.id)) blockMap.set(block.id, block);
  }

  return Array.from(blockMap.values()).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
};

export const getSystemHomeBlocks = async ({ input }: { input: GetSystemHomeBlocksInputSchema }) => {
  const homeBlocks = await dbRead.homeBlock.findMany({
    select: homeBlockSelect,
    orderBy: { index: { sort: 'asc', nulls: 'last' } },
    where: {
      userId: -1,
      permanent: input.permanent !== undefined ? input.permanent : undefined,
    },
  });

  return homeBlocks.map((homeBlock) => ({
    ...homeBlock,
    metadata: homeBlock.metadata as HomeBlockMetaSchema,
  }));
};

export const getHomeBlockById = async ({
  id,
  domain,
}: GetHomeBlockByIdInputSchema & {
  // SessionUser required because it's passed down to getHomeBlockData
  user?: SessionUser;
}) => {
  const homeBlockFindArgs = {
    select: {
      id: true,
      metadata: true,
      type: true,
      userId: true,
      sourceId: true,
    },
    where: {
      id,
    },
  } as const;
  const homeBlock = await dbRead.homeBlock.findUniqueOrThrow(homeBlockFindArgs).catch(() => {
    dbReadFallbackCounter.inc({ entity: 'homeBlock', caller: 'getHomeBlockById' });
    return dbWrite.homeBlock.findUniqueOrThrow(homeBlockFindArgs);
  });

  if (!homeBlock) {
    return null;
  }

  return getHomeBlockCached(
    {
      ...homeBlock,
      metadata: homeBlock.metadata as HomeBlockMetaSchema,
    },
    domain
  );
};

// `moreHref` is carried from the block's own metadata, not from the board row, so
// it has to be grafted onto the service's return type.
type GetLeaderboardsWithResults = (AsyncReturnType<typeof getLeaderboardsWithResults>[number] & {
  moreHref?: string;
})[];
type GetAnnouncements = AsyncReturnType<typeof getCurrentAnnouncements>;
type GetCollectionWithItems = AsyncReturnType<typeof getCollectionById> & {
  items: AsyncReturnType<typeof getCollectionItemsByCollectionId>['items'];
};
type GetShopSectionsWithItems = AsyncReturnType<typeof getShopSectionsWithItems>[number];

/** A Feed block's resolved slice. `entity` tells the renderer which card to use. */
export type FeedBlockItems =
  | { entity: 'images'; items: AsyncReturnType<typeof getAllImagesIndex>['items'] }
  | { entity: 'models'; items: GetModelsWithImagesAndModelVersions[] };

export type PickedFeaturedCollection = {
  collection: AsyncReturnType<typeof getCollectionById>;
  items: AsyncReturnType<typeof getCollectionItemsByCollectionId>['items'];
  rows: number;
  limit: number;
  // Optional because a Redis entry written before this field existed still deserializes
  // into this type; those render uncapped until the 3-minute block cache turns over.
  maxPerUser?: number;
};

export type HomeBlockWithData = {
  id: number;
  metadata: HomeBlockMetaSchema;
  type: HomeBlockType;
  userId?: number;
  index?: number | null;
  sourceId?: number | null;
  collection?: GetCollectionWithItems;
  leaderboards?: GetLeaderboardsWithResults;
  announcements?: GetAnnouncements;
  cosmeticShopSection?: GetShopSectionsWithItems;
  featuredModels?: GetModelsWithImagesAndModelVersions[];
  pickedCollections?: PickedFeaturedCollection[];
  feedItems?: FeedBlockItems;
};

// Baseline feed inputs a Feed block always applies. These are the shape the feed
// services require, not policy — anything a block should be able to vary belongs in
// the metadata allowlist instead.
const imageFeedDefaults = {
  period: MetricTimeframe.Week,
  periodMode: 'published',
  sort: ImageSort.MostReactions,
  // Every one of these is load-bearing for the card, and the feed returns null/[] for
  // whatever is missing rather than erroring:
  //   cosmetics + profilePictures -> the creator's avatar and frame
  //   tagIds -> what useApplyHiddenPreferences matches a viewer's hidden tags against,
  //             so omitting it silently stops honoring them
  // getInfiniteImagesHandler appends tagIds for the same reason; this path calls
  // getAllImagesIndex directly, so it has to ask for them itself.
  include: ['cosmetics', 'profilePictures', 'tagIds'] as ImageInclude[],
  withMeta: false,
  types: undefined,
} as const;

// Mirrors `homeBlockMetaSchema.feed.limit`, which never runs: `getHomeBlockData` casts the
// stored metadata rather than parsing it, and no route writes a Feed block — the only writer is
// hand-written SQL. So these are the sole guard against a typo, not a redundant second one.
const FEED_FETCH_CEILING = 100;
const FEED_FETCH_DEFAULT = 28;

/**
 * How many items a Feed block fetches. Nothing scales the configured value, so what the config
 * says is what ships — a `limit` of 42 fetches 42.
 *
 * The value has to sit well above the rendered slice (`rows * HOME_BLOCK_ITEMS_PER_ROW`), because
 * `maxPerUser` and the viewer's own hidden-preferences filter both thin the pool after the fetch,
 * and the fetch applies no per-creator cap of its own — so the head of the pool is
 * creator-concentrated. Measured on the two live blocks: 454066 (7 slots) fills at 7, but 454065
 * (14 slots) needs 21, and its first 7 items come from only 4 creators.
 *
 * Exported for unit tests.
 */
export function resolveFeedFetchLimit(limit?: number) {
  return Math.min(limit ?? FEED_FETCH_DEFAULT, FEED_FETCH_CEILING);
}

// Both model-carrying home blocks take this pair. The images come straight from the shared
// cache, in `postId,index` order and never browsing-level filtered, so a plain cap can leave
// a mixed-level model with no image a given viewer may see — and the client-side filter then
// drops the whole model rather than the image. The bit-coverage slice is what makes the cap
// safe, which is why the two travel together.
const slimModelImages = {
  imagesPerModel: GET_ALL_IMAGES_PER_MODEL_SLIM,
  biasImageSlice: true,
} as const;

const modelFeedDefaults = {
  period: MetricTimeframe.Week,
  periodMode: 'published',
  sort: ModelSort.HighestRated,
  favorites: false,
  hidden: false,
} as const;

// PG only unless a block opts up. The rest of the site treats PG+PG13 as "SFW", but
// nothing on the home page has passed human review before appearing there.
const feedBrowsingLevel = (level?: 'public' | 'sfw') =>
  level === 'sfw' ? sfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;

const readThroughTypes: HomeBlockType[] = [
  HomeBlockType.Feed,
  HomeBlockType.Leaderboard,
  HomeBlockType.CosmeticShop,
  HomeBlockType.FeaturedCollections,
];

export const getHomeBlockData = async ({
  user,
  input,
  homeBlock,
}: {
  homeBlock: {
    id: number;
    metadata?: HomeBlockMetaSchema | Prisma.JsonValue;
    type: HomeBlockType;
    userId?: number;
    sourceId?: number | null;
  };
  // `domain` isn't part of the public getHomeBlocks input — it's supplied by the
  // by-id cached path, which is the only caller whose blocks are domain-scoped.
  input: GetHomeBlocksInputSchema & { domain?: DomainColor };
  // Session user required because it's passed down to collection get items service
  // which requires it for models/posts/etc
  user?: SessionUser;
}): Promise<HomeBlockWithData | null> => {
  const metadata: HomeBlockMetaSchema = (homeBlock.metadata || {}) as HomeBlockMetaSchema;

  // System block is source of truth for content selection; cloned user blocks read through to
  // source so mods only update the singleton and clones stay in sync. Only the types below drift
  // in practice — upsertHomeBlock already propagates metadata to clones, so this covers system
  // blocks edited out-of-band (direct SQL/Retool).
  let sourceMetadata: HomeBlockMetaSchema | undefined;
  if (homeBlock.sourceId && readThroughTypes.includes(homeBlock.type)) {
    const source = await dbRead.homeBlock.findUnique({
      where: { id: homeBlock.sourceId },
      select: { metadata: true },
    });
    sourceMetadata = (source?.metadata || undefined) as HomeBlockMetaSchema | undefined;
  }

  switch (homeBlock.type) {
    case HomeBlockType.Collection: {
      if (!metadata.collection || !metadata.collection.id) {
        return null;
      }

      const collection = await getCollectionById({
        input: { id: metadata.collection.id },
      });

      if (!collection) {
        return null;
      }

      const result = input.withCoreData
        ? { items: [], nextCursor: undefined }
        : await getCollectionItemsByCollectionId({
            user,
            input: {
              collectionId: collection.id,
              // Whichever pool is larger. `input.limit` used to win outright, which made a
              // block's own `limit` unreachable — so raising it to give `maxPerUser` more
              // creators to pick from had no effect. 100 is getAllCollectionItemsSchema's max.
              limit: Math.min(100, Math.max(input.limit ?? 0, metadata.collection.limit ?? 0)),
              browsingLevel: sfwBrowsingLevelsFlag,
              collectionTagId: metadata.collection.tagId,
            },
          });

      return {
        ...homeBlock,
        type: HomeBlockType.Collection,
        metadata,
        collection: {
          ...collection,
          items: result.items,
        },
      };
    }
    case HomeBlockType.Leaderboard: {
      const leaderboards = sourceMetadata?.leaderboards ?? metadata.leaderboards;
      if (!leaderboards) {
        return null;
      }

      const leaderboardIds = leaderboards.map((leaderboard) => leaderboard.id);

      const leaderboardsWithResults = await getLeaderboardsWithResults({
        ids: leaderboardIds,
        isModerator: user?.isModerator || false,
        domain: input.domain,
      });

      return {
        ...homeBlock,
        metadata,
        leaderboards: leaderboardsWithResults
          .map((board) => ({
            ...board,
            moreHref: leaderboards.find((item) => item.id === board.id)?.moreHref,
          }))
          .sort((a, b) => {
            const aIndex = leaderboards.find((item) => item.id === a.id)?.index ?? 0;
            const bIndex = leaderboards.find((item) => item.id === b.id)?.index ?? 0;

            return aIndex - bIndex;
          }),
      };
    }
    case HomeBlockType.Feed: {
      const feed = sourceMetadata?.feed ?? metadata.feed;
      if (!feed) return null;

      const limit = resolveFeedFetchLimit(feed.limit);

      if (feed.entity === 'images') {
        const { items } = await getAllImagesIndex({
          ...imageFeedDefaults,
          browsingLevel: feedBrowsingLevel(feed.browsingLevel),
          limit,
          domain: input.domain,
          sort: (feed.sort as ImageSort) ?? ImageSort.MostReactions,
          period: feed.period ?? MetricTimeframe.Week,
          newCreators: feed.newCreators,
          types: feed.types,
          user,
          headers: { src: 'getHomeBlockData:feed' },
        });

        return { ...homeBlock, metadata, feedItems: { entity: 'images' as const, items } };
      }

      const { items } = await getModelsWithImagesAndModelVersions({
        input: {
          ...modelFeedDefaults,
          browsingLevel: feedBrowsingLevel(feed.browsingLevel),
          limit,
          sort: (feed.sort as ModelSort) ?? ModelSort.HighestRated,
          period: feed.period ?? MetricTimeframe.Week,
          newCreators: feed.newCreators,
          baseModels: feed.baseModels,
        },
        user,
        domain: input.domain,
        ...slimModelImages,
      });

      return { ...homeBlock, metadata, feedItems: { entity: 'models' as const, items } };
    }
    case HomeBlockType.CosmeticShop: {
      const cosmeticShopSectionMeta =
        sourceMetadata?.cosmeticShopSection ?? metadata.cosmeticShopSection;
      if (!cosmeticShopSectionMeta) {
        return null;
      }

      // No feature flags in this context — creator-listed items stay excluded
      // from homepage shop blocks until the creatorShop flag goes GA.
      const data = await getShopSectionsWithItems({
        sectionId: cosmeticShopSectionMeta.id,
      });

      const [cosmeticShopSection] = data;

      if (!cosmeticShopSection || cosmeticShopSection._count.items === 0) {
        return null;
      }

      return {
        ...homeBlock,
        // Client slices by metadata.cosmeticShopSection.maxItems, so hand back the section we
        // actually resolved rather than the clone's snapshot of a different section.
        metadata: { ...metadata, cosmeticShopSection: cosmeticShopSectionMeta },
        cosmeticShopSection,
      };
    }
    case HomeBlockType.FeaturedCollections: {
      const effectivePool = sourceMetadata?.featuredCollections ?? metadata.featuredCollections;
      if (!effectivePool?.collectionIds?.length) return null;

      const state = await getFeaturedCollectionsState();
      let candidates: number[];
      if (state === null) {
        // Redis miss (pre-first-job-run) — bootstrap with full pool.
        candidates = effectivePool.collectionIds;
      } else {
        const eligible = state.eligibleIds.filter((id) =>
          effectivePool!.collectionIds.includes(id)
        );
        // Job ran and determined nothing qualifies — hide the block rather than show stale.
        if (eligible.length === 0) return null;
        candidates = eligible;
      }

      const { limit, rows, maxPerUser, renderCount } = resolveFeaturedCollectionsLayout(
        effectivePool,
        candidates.length
      );

      // Fisher-Yates shuffle, take N.
      const pool = [...candidates];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const picks = pool.slice(0, renderCount);

      const hydrated = await Promise.all(
        picks.map(async (id) => {
          const col = await getCollectionById({ input: { id } });
          if (!col) return null;
          const result = input.withCoreData
            ? { items: [], nextCursor: undefined }
            : await getCollectionItemsByCollectionId({
                user,
                input: {
                  collectionId: id,
                  limit,
                  browsingLevel: sfwBrowsingLevelsFlag,
                },
              });
          // Drop picks with zero items post-SFW filter — don't render an empty grid block
          // (e.g. a curator whose collection is all R/X would show a ghost section otherwise).
          if (!input.withCoreData && result.items.length === 0) return null;
          return { collection: col, items: result.items, rows, limit, maxPerUser };
        })
      );

      const pickedCollections = hydrated.filter(isDefined);
      if (pickedCollections.length === 0) return null;

      return {
        ...homeBlock,
        type: HomeBlockType.FeaturedCollections,
        // A clone's own copy is a snapshot from clone time; serving it advertises config that
        // isn't in effect.
        metadata: { ...metadata, featuredCollections: effectivePool },
        pickedCollections,
      };
    }
    case HomeBlockType.FeaturedModelVersion: {
      // TODO eventually switch this to the actual version
      const featured = await getFeaturedModels();

      const modelData =
        featured.length > 0
          ? (
              await getModelsWithImagesAndModelVersions({
                user,
                input: {
                  ids: featured.map((f) => f.modelId),
                  limit: featured.length,
                  hidden: false,
                  favorites: false,
                  sort: ModelSort.HighestRated,
                  period: MetricTimeframe.AllTime,
                  periodMode: 'stats',
                  browsingLevel: allBrowsingLevelsFlag,
                },
                ...slimModelImages,
              })
            ).items
          : ([] as GetModelsWithImagesAndModelVersions[]);

      const validModelData = modelData.filter(
        (m) => hasSafeBrowsingLevel(m.nsfwLevel) && !m.nsfw && !m.poi
      );

      const validModelDataSorted = validModelData.sort((a, b) => {
        const matchA = featured.find((f) => f.modelId === a.id);
        const matchB = featured.find((f) => f.modelId === b.id);
        if (!matchA || !matchA.position) return 1;
        if (!matchB || !matchB.position) return -1;
        return matchA.position - matchB.position;
      });

      const filteredModelData: typeof validModelDataSorted = [];
      const creatorsSeen: Record<number, number> = {};
      const maxEntries = 3;

      validModelDataSorted.forEach((md) => {
        const creatorSeen = creatorsSeen[md.user.id] ?? 0;
        if (creatorSeen < maxEntries) {
          filteredModelData.push(md);
          creatorsSeen[md.user.id] = creatorSeen + 1;
        }
      });

      const limitedData = filteredModelData.slice(0, input.limit);
      // TODO optionally limit position to <= modelsToAddToCollection

      return {
        ...homeBlock,
        metadata,
        featuredModels: limitedData,
      };
    }
    default:
      return { ...homeBlock, metadata };
  }
};

export const userHasCustomHomeBlocks = async (userId?: number) => {
  if (!userId) {
    return false;
  }

  const [row]: { exists: boolean }[] = await dbRead.$queryRaw`
    SELECT EXISTS(
        SELECT 1 FROM "HomeBlock" hb WHERE hb."userId"=${userId}
      )
  `;

  const { exists } = row;

  return exists;
};

export const upsertHomeBlock = async ({
  input,
}: {
  input: UpsertHomeBlockInput & { userId: number; isModerator?: boolean };
}) => {
  const { userId, isModerator, id, metadata, type, sourceId } = input;
  let { index } = input;

  if (id) {
    const homeBlock = await dbRead.homeBlock.findUnique({
      select: { userId: true },
      where: { id },
    });

    if (!homeBlock) {
      throw throwNotFoundError('Home block not found.');
    }

    if (userId !== homeBlock.userId && !isModerator) {
      throw throwAuthorizationError('You are not authorized to edit this home block.');
    }

    const updated = await dbWrite.homeBlock.updateMany({
      where: { OR: [{ id }, { sourceId: id }] },
      data: {
        metadata,
        index,
      },
    });

    return updated;
  }

  const userHasHomeBlocks = await userHasCustomHomeBlocks(userId);

  if (!userHasHomeBlocks) {
    index = 0; // new collection will be added on top.

    // Clone system home blocks:
    const homeBlockData = await getSystemHomeBlocks({ input: { permanent: false } });

    const data = homeBlockData
      .map((source) => {
        return {
          userId,
          index: (source.index ?? 0) + 1, // Ensures this will all fall below the new user created home block.
          type: source.type,
          sourceId: source?.id,
          metadata: source.metadata || {},
        };
      })
      .filter(isDefined);

    if (data.length > 0) {
      await dbWrite.homeBlock.createMany({
        data,
      });
    }
  }

  return dbWrite.homeBlock.create({
    data: {
      metadata,
      type,
      sourceId,
      index,
      userId,
    },
  });
};

export const deleteHomeBlockById = async ({
  input,
}: {
  input: GetByIdInput & { userId: number; isModerator?: boolean };
}) => {
  try {
    const { id, userId, isModerator } = input;
    const homeBlock = await dbRead.homeBlock.findFirst({
      // Confirm the homeBlock belongs to the user:
      where: { id, userId: isModerator ? undefined : userId },
      select: { id: true, userId: true },
    });

    if (!homeBlock) {
      return null;
    }

    return await dbWrite.homeBlock.delete({ where: { id } });
  } catch {
    // Ignore errors
  }
};

type FeaturedCollectionsPool = NonNullable<HomeBlockMetaSchema['featuredCollections']>;

/**
 * `limit` is the fetch pool, not the visible count — it meant the visible count once, and stored
 * metadata predating that still says 8. Floored at the visible slice so it can't starve the grid.
 */
export function resolveFeaturedCollectionsLayout(
  // Partial: the caller's value is an unvalidated JSON cast, not schema output.
  pool: Partial<Pick<FeaturedCollectionsPool, 'limit' | 'rows' | 'renderCount' | 'maxPerUser'>>,
  candidateCount: number
) {
  const rows = Math.min(4, Math.max(1, pool.rows || 2));
  // Deliberately not `input.limit`: the by-id cache path passes one fixed number for every
  // block type, and letting it win made this block's own `limit` dead config.
  const limit = Math.min(
    100,
    Math.max(rows * HOME_BLOCK_ITEMS_PER_ROW, pool.limit || FEATURED_COLLECTIONS_DEFAULTS.limit)
  );
  const maxPerUser = pool.maxPerUser ?? FEATURED_COLLECTIONS_DEFAULTS.maxPerUser;
  const renderCount = Math.min(10, Math.max(1, pool.renderCount ?? 3), candidateCount);

  return { limit, rows, maxPerUser, renderCount };
}

export const FEATURED_COLLECTIONS_DEFAULTS = {
  // The fetch pool, not the visible count (rows * 7 of these render). Sized well above the
  // visible slice so `maxPerUser` has other creators to promote instead of leaving holes.
  limit: 100,
  rows: 2,
  renderCount: 3,
  maxPerUser: 2,
  title: 'Featured Collection',
};

async function getOrCreateFeaturedCollectionsSystemBlock() {
  const existing = await dbWrite.homeBlock.findFirst({
    where: { userId: -1, type: HomeBlockType.FeaturedCollections },
    select: homeBlockSelect,
  });
  if (existing) return existing;

  return dbWrite.homeBlock.create({
    data: {
      userId: -1,
      type: HomeBlockType.FeaturedCollections,
      metadata: {
        title: FEATURED_COLLECTIONS_DEFAULTS.title,
        featuredCollections: {
          collectionIds: [],
          limit: FEATURED_COLLECTIONS_DEFAULTS.limit,
          rows: FEATURED_COLLECTIONS_DEFAULTS.rows,
          renderCount: FEATURED_COLLECTIONS_DEFAULTS.renderCount,
          maxPerUser: FEATURED_COLLECTIONS_DEFAULTS.maxPerUser,
          nameSnapshots: {},
        },
      },
    },
    select: homeBlockSelect,
  });
}

export const getFeaturedCollectionsPool = async () => {
  const block = await dbRead.homeBlock.findFirst({
    where: { userId: -1, type: HomeBlockType.FeaturedCollections },
    select: homeBlockSelect,
  });
  const metadata = (block?.metadata || {}) as HomeBlockMetaSchema;
  const collectionIds = metadata.featuredCollections?.collectionIds ?? [];
  return {
    homeBlockId: block?.id ?? null,
    collectionIds,
    metadata,
  };
};

type PoolMutation = {
  ids?: (ids: number[]) => number[];
  nameSnapshots?: (snap: Record<string, string>) => Record<string, string>;
  writeSnapshots?: (snap: Record<string, string>) => Record<string, string>;
};

async function updateFeaturedPool(
  mutation: PoolMutation
): Promise<{ homeBlockId: number; collectionIds: number[] }> {
  const block = await getOrCreateFeaturedCollectionsSystemBlock();
  const metadata = (block.metadata || {}) as HomeBlockMetaSchema;
  const currentIds = metadata.featuredCollections?.collectionIds ?? [];
  const currentNameSnaps = metadata.featuredCollections?.nameSnapshots ?? {};
  const currentWriteSnaps = metadata.featuredCollections?.writeSnapshots ?? {};
  const nextIds = mutation.ids ? mutation.ids(currentIds) : currentIds;
  const nextNameSnaps = mutation.nameSnapshots
    ? mutation.nameSnapshots(currentNameSnaps)
    : currentNameSnaps;
  const nextWriteSnaps = mutation.writeSnapshots
    ? mutation.writeSnapshots(currentWriteSnaps)
    : currentWriteSnaps;

  const newMetadata: HomeBlockMetaSchema = {
    ...metadata,
    featuredCollections: {
      collectionIds: nextIds,
      limit: metadata.featuredCollections?.limit ?? FEATURED_COLLECTIONS_DEFAULTS.limit,
      rows: metadata.featuredCollections?.rows ?? FEATURED_COLLECTIONS_DEFAULTS.rows,
      renderCount:
        metadata.featuredCollections?.renderCount ?? FEATURED_COLLECTIONS_DEFAULTS.renderCount,
      maxPerUser:
        metadata.featuredCollections?.maxPerUser ?? FEATURED_COLLECTIONS_DEFAULTS.maxPerUser,
      maxStaleDays: metadata.featuredCollections?.maxStaleDays,
      minRecentItems: metadata.featuredCollections?.minRecentItems,
      nameSnapshots: nextNameSnaps,
      writeSnapshots: nextWriteSnaps,
    },
  };

  // Only mutate the system block. Cloned user blocks (sourceId=block.id) may have user-customized
  // fields (title, description) — we'd clobber them. Runtime hydration pulls pool state from the
  // source block via sourceId lookup, so clones stay in sync without their metadata being touched.
  await dbWrite.homeBlock.update({
    where: { id: block.id },
    data: { metadata: newMetadata },
  });

  // Bust the permanent-blocks list cache so if the FeaturedCollections row is flagged permanent,
  // the 1-day-TTL'd list doesn't serve stale metadata to cold-cache users.
  await redis.del(REDIS_KEYS.CACHES.HOME_BLOCKS_PERMANENT);

  // Recompute Redis state after pool changes so eligibility reflects reality.
  await computeFeaturedCollectionsState();

  return { homeBlockId: block.id, collectionIds: nextIds };
}

export const addCollectionToFeaturedPool = async ({ collectionId }: { collectionId: number }) => {
  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: { id: true, name: true, write: true },
  });
  if (!collection) throw throwNotFoundError('Collection not found');

  return updateFeaturedPool({
    ids: (current) => (current.includes(collectionId) ? current : [...current, collectionId]),
    nameSnapshots: (snap) => ({ ...snap, [collectionId]: collection.name }),
    writeSnapshots: (snap) => ({ ...snap, [collectionId]: collection.write }),
  });
};

export const removeCollectionFromFeaturedPool = async ({
  collectionId,
}: {
  collectionId: number;
}) => {
  return updateFeaturedPool({
    ids: (current) => current.filter((id) => id !== collectionId),
    nameSnapshots: (snap) => {
      const next = { ...snap };
      delete next[collectionId];
      return next;
    },
    writeSnapshots: (snap) => {
      const next = { ...snap };
      delete next[collectionId];
      return next;
    },
  });
};

// Re-snapshot name + write for a single collection. Mods call this after reviewing
// a drift warning to re-approve the collection's current state.
export const acknowledgeFeaturedCollection = async ({ collectionId }: { collectionId: number }) => {
  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: { id: true, name: true, write: true },
  });
  if (!collection) throw throwNotFoundError('Collection not found');

  return updateFeaturedPool({
    nameSnapshots: (snap) => ({ ...snap, [collectionId]: collection.name }),
    writeSnapshots: (snap) => ({ ...snap, [collectionId]: collection.write }),
  });
};

/**
 * Mod-driven HomeBlock writes (Retool / future on-site Manager UI). Scoped to
 * the system user (userId = -1) — these endpoints must never mutate a regular
 * user's personalized home blocks. The system user owns the editorial homepage
 * configuration that everyone sees by default.
 */
const SYSTEM_HOMEBLOCK_USER_ID = -1;

async function assertSystemHomeBlock(id: number) {
  const row = await dbRead.homeBlock.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!row) throw throwNotFoundError(`No HomeBlock with id ${id}`);
  if (row.userId !== SYSTEM_HOMEBLOCK_USER_ID) {
    throw throwAuthorizationError(
      `HomeBlock ${id} is owned by user ${row.userId}; admin endpoints only operate on system blocks (userId=${SYSTEM_HOMEBLOCK_USER_ID}).`
    );
  }
}

export async function createHomeBlockAdmin({
  type,
  metadata,
  sourceId,
  index,
  permanent,
}: {
  type: HomeBlockType;
  metadata: Prisma.InputJsonValue;
  sourceId?: number;
  index?: number;
  permanent?: boolean;
}) {
  return dbWrite.homeBlock.create({
    data: {
      userId: SYSTEM_HOMEBLOCK_USER_ID,
      type,
      metadata,
      sourceId,
      index,
      permanent: permanent ?? false,
    },
  });
}

export async function updateHomeBlockAdmin({
  id,
  metadata,
  index,
  permanent,
  type,
  sourceId,
}: {
  id: number;
  metadata?: Prisma.InputJsonValue;
  index?: number | null;
  permanent?: boolean;
  type?: HomeBlockType;
  sourceId?: number | null;
}) {
  await assertSystemHomeBlock(id);
  const data: Prisma.HomeBlockUncheckedUpdateInput = {};
  if (metadata !== undefined) data.metadata = metadata;
  if (index !== undefined) data.index = index;
  if (permanent !== undefined) data.permanent = permanent;
  if (type !== undefined) data.type = type;
  if (sourceId !== undefined) data.sourceId = sourceId;
  const updated = await dbWrite.homeBlock.update({ where: { id }, data });

  // The permanent-block list is cached for a day and nothing else here busts it, so flipping
  // `permanent` leaves the read path serving the old set while setHomeBlocksOrder reads the
  // new one live — a block that renders for nobody until the TTL turns over.
  await redis.del(REDIS_KEYS.CACHES.HOME_BLOCKS_PERMANENT);

  return updated;
}

export async function deleteHomeBlockAdmin({ id }: { id: number }) {
  await assertSystemHomeBlock(id);
  await dbWrite.homeBlock.delete({ where: { id } });
  return { deleted: true };
}

export async function reorderHomeBlocksAdmin({ orderedIds }: { orderedIds: number[] }) {
  const unique = new Set(orderedIds);
  if (unique.size !== orderedIds.length) {
    throw throwBadRequestError('orderedIds must not contain duplicates');
  }
  // Verify every block belongs to the system user before touching anything.
  const rows = await dbRead.homeBlock.findMany({
    where: { id: { in: orderedIds } },
    select: { id: true, userId: true },
  });
  const foreign = rows.filter((r) => r.userId !== SYSTEM_HOMEBLOCK_USER_ID);
  if (foreign.length) {
    throw throwAuthorizationError(
      `HomeBlocks [${foreign.map((r) => r.id).join(',')}] are not system-owned; reorder rejected.`
    );
  }
  if (rows.length !== orderedIds.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = orderedIds.filter((id) => !found.has(id));
    throw throwBadRequestError(`HomeBlocks not found: [${missing.join(',')}]`);
  }

  await dbWrite.$transaction(
    orderedIds.map((id, index) => dbWrite.homeBlock.update({ where: { id }, data: { index } }))
  );
  return { count: orderedIds.length };
}

export const setHomeBlocksOrder = async ({
  input,
}: {
  input: SetHomeBlocksOrderInputSchema & { userId: number };
}) => {
  const { userId, homeBlocks } = input;
  if (homeBlocks.find((homeBlock) => homeBlock.userId !== -1 && homeBlock.userId !== userId)) {
    throw throwBadRequestError('Cloning home blocks from other users is not supported.');
  }

  const homeBlockIds = homeBlocks.map((i) => i.id);
  const systemBlocksRequested = homeBlocks.filter((i) => i.userId === -1);
  const ownedHomeBlocks = homeBlocks.filter((i) => i.userId === userId);

  // Permanent blocks are unioned into every homepage already, so a clone of one is a second
  // copy rather than a preference. getHomeBlocks drops such clones on read; not writing them
  // keeps that from being load-bearing. Same predicate upsertHomeBlock's clone loop uses.
  const clonableSources = systemBlocksRequested.length
    ? await dbRead.homeBlock.findMany({
        select: { id: true, type: true, metadata: true },
        where: {
          id: { in: systemBlocksRequested.map((i) => i.id) },
          userId: -1,
          permanent: false,
        },
      })
    : [];

  const transactions = [];
  // Anything absent from the submitted list is a removal — but the editor is no longer seeded
  // with clones of permanent blocks, so for those absence means "never offered", not "removed".
  // Sweeping them would delete the last row of a user who kept only a permanent block, and this
  // app reads "no rows" as "never customized", which hands that user the full default homepage.
  const homeBlocksToRemove = await dbRead.homeBlock.findMany({
    select: { id: true },
    where: {
      userId,
      id: { not: { in: homeBlockIds } },
      OR: [{ sourceId: null }, { source: { permanent: false } }],
    },
  });

  // if we have items to remove, add a deleteMany mutation to the transaction
  if (homeBlocksToRemove.length) {
    transactions.push(
      dbWrite.homeBlock.deleteMany({
        where: { id: { in: homeBlocksToRemove.map((i) => i.id) } },
      })
    );
  }

  if (clonableSources.length) {
    const data = systemBlocksRequested
      .map((i) => {
        const source = clonableSources.find((item) => item.id === i.id);

        if (!source) {
          return null;
        }

        return {
          userId,
          index: i.index,
          type: source.type,
          sourceId: source.id,
          metadata: (source.metadata || {}) as Prisma.InputJsonValue,
        };
      })
      .filter(isDefined);

    if (data.length > 0) {
      transactions.push(
        dbWrite.homeBlock.createMany({
          data,
        })
      );
    }
  }

  if (ownedHomeBlocks.length) {
    transactions.push(
      ...ownedHomeBlocks.map((homeBlock) =>
        dbWrite.homeBlock.update({ where: { id: homeBlock.id }, data: { index: homeBlock.index } })
      )
    );
  }

  return dbWrite.$transaction(transactions);
};
