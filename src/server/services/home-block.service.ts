import type { Prisma } from '@prisma/client';
import type { SessionUser } from 'next-auth';
import { CacheTTL } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';
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
import type { getCurrentAnnouncements } from '~/server/services/announcement.service';
import {
  getCollectionById,
  getCollectionItemsByCollectionId,
} from '~/server/services/collection.service';
import { getShopSectionsWithItems } from '~/server/services/cosmetic-shop.service';
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
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  allBrowsingLevelsFlag,
  hasSafeBrowsingLevel,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { HomeBlockType, MetricTimeframe } from '~/shared/utils/prisma/enums';
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

  const where: Prisma.HomeBlockWhereInput = ownedOnly
    ? { userId }
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

  // Combine and deduplicate - user blocks take precedence over permanent
  const blockMap = new Map(userBlocks.map((b) => [b.id, b]));
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

  return getHomeBlockCached({
    ...homeBlock,
    metadata: homeBlock.metadata as HomeBlockMetaSchema,
  });
};

type GetLeaderboardsWithResults = AsyncReturnType<typeof getLeaderboardsWithResults>;
type GetAnnouncements = AsyncReturnType<typeof getCurrentAnnouncements>;
type GetCollectionWithItems = AsyncReturnType<typeof getCollectionById> & {
  items: AsyncReturnType<typeof getCollectionItemsByCollectionId>['items'];
};
type GetShopSectionsWithItems = AsyncReturnType<typeof getShopSectionsWithItems>[number];

export type PickedFeaturedCollection = {
  collection: AsyncReturnType<typeof getCollectionById>;
  items: AsyncReturnType<typeof getCollectionItemsByCollectionId>['items'];
  rows: number;
  limit: number;
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
};

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
  input: GetHomeBlocksInputSchema;
  // Session user required because it's passed down to collection get items service
  // which requires it for models/posts/etc
  user?: SessionUser;
}): Promise<HomeBlockWithData | null> => {
  const metadata: HomeBlockMetaSchema = (homeBlock.metadata || {}) as HomeBlockMetaSchema;

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
              limit: input.limit || metadata.collection.limit,
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
      if (!metadata.leaderboards) {
        return null;
      }

      const leaderboardIds = metadata.leaderboards.map((leaderboard) => leaderboard.id);

      const leaderboardsWithResults = await getLeaderboardsWithResults({
        ids: leaderboardIds,
        isModerator: user?.isModerator || false,
      });

      return {
        ...homeBlock,
        metadata,
        leaderboards: leaderboardsWithResults.sort((a, b) => {
          if (!metadata.leaderboards) {
            return 0;
          }

          const aIndex = metadata.leaderboards.find((item) => item.id === a.id)?.index ?? 0;
          const bIndex = metadata.leaderboards.find((item) => item.id === b.id)?.index ?? 0;

          return aIndex - bIndex;
        }),
      };
    }
    case HomeBlockType.CosmeticShop: {
      if (!metadata.cosmeticShopSection) {
        return null;
      }

      const data = await getShopSectionsWithItems({
        sectionId: metadata.cosmeticShopSection.id,
      });

      const [cosmeticShopSection] = data;

      if (!cosmeticShopSection || cosmeticShopSection._count.items === 0) {
        return null;
      }

      return {
        ...homeBlock,
        metadata,
        cosmeticShopSection,
      };
    }
    case HomeBlockType.FeaturedCollections: {
      // System block is source of truth for pool; cloned user blocks read through to source
      // so mods only update the singleton and clones stay in sync.
      let effectivePool = metadata.featuredCollections;
      if (homeBlock.sourceId) {
        const source = await dbRead.homeBlock.findUnique({
          where: { id: homeBlock.sourceId },
          select: { metadata: true },
        });
        const sourceMeta = (source?.metadata || {}) as HomeBlockMetaSchema;
        effectivePool = sourceMeta.featuredCollections ?? effectivePool;
      }
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

      // Clamp to sane bounds — metadata is mutable JSON, don't trust blindly.
      const limit = Math.min(50, Math.max(1, input.limit || effectivePool.limit || 8));
      const rows = Math.min(4, Math.max(1, effectivePool.rows || 2));
      const renderCount = Math.min(
        10,
        Math.max(1, effectivePool.renderCount ?? 3),
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
          return { collection: col, items: result.items, rows, limit };
        })
      );

      const pickedCollections = hydrated.filter(isDefined);
      if (pickedCollections.length === 0) return null;

      return {
        ...homeBlock,
        type: HomeBlockType.FeaturedCollections,
        metadata,
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

const FEATURED_COLLECTIONS_DEFAULTS = {
  limit: 8,
  rows: 2,
  renderCount: 3,
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
  const homeBlocksToClone = homeBlocks.filter((i) => i.userId === -1);
  const ownedHomeBlocks = homeBlocks.filter((i) => i.userId === userId);

  const transactions = [];
  const homeBlocksToRemove = await dbRead.homeBlock.findMany({
    select: { id: true },
    where: { userId, id: { not: { in: homeBlockIds } } },
  });

  // if we have items to remove, add a deleteMany mutation to the transaction
  if (homeBlocksToRemove.length) {
    transactions.push(
      dbWrite.homeBlock.deleteMany({
        where: { id: { in: homeBlocksToRemove.map((i) => i.id) } },
      })
    );
  }

  if (homeBlocksToClone.length) {
    const homeBlockData = await getHomeBlocks({
      ids: homeBlocksToClone.map((i) => i.id),
    });

    const data = homeBlocksToClone
      .map((i) => {
        const source = homeBlockData.find((item) => item.id === i.id);

        if (!source) {
          return null;
        }

        return {
          userId,
          index: i.index,
          type: source.type,
          sourceId: source?.id,
          metadata: source.metadata || {},
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
