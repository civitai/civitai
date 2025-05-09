import type { Prisma } from '@prisma/client';
import type { SessionUser } from 'next-auth';
import { ModelSort } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetHomeBlockByIdInputSchema,
  GetHomeBlocksInputSchema,
  GetSystemHomeBlocksInputSchema,
  HomeBlockMetaSchema,
  SetHomeBlocksOrderInputSchema,
  UpsertHomeBlockInput,
} from '~/server/schema/home-block.schema';
import { getCurrentAnnouncements } from '~/server/services/announcement.service';
import {
  getCollectionById,
  getCollectionItemsByCollectionId,
} from '~/server/services/collection.service';
import { getShopSectionsWithItems } from '~/server/services/cosmetic-shop.service';
import { getHomeBlockCached } from '~/server/services/home-block-cache.service';
import { getLeaderboardsWithResults } from '~/server/services/leaderboard.service';
import {
  getFeaturedModels,
  GetModelsWithImagesAndModelVersions,
  getModelsWithImagesAndModelVersions,
} from '~/server/services/model.service';
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

export const getHomeBlocks = async <
  TSelect extends Prisma.HomeBlockSelect = Prisma.HomeBlockSelect
>({
  select,
  userId,
  ...input
}: {
  select: TSelect;
  userId?: number;
  ownedOnly?: boolean;
  ids?: number[];
}) => {
  const hasCustomHomeBlocks = await userHasCustomHomeBlocks(userId);

  const { ownedOnly, ids } = input;

  if (ownedOnly && !userId) {
    throw throwBadRequestError('You must be logged in to view your home blocks.');
  }

  if (!hasCustomHomeBlocks && !ownedOnly && !ids) {
    // If the user doesn't have any custom home blocks, we can just return the default Civitai ones.
    return getSystemHomeBlocks({ input: {} });
  }

  return dbRead.homeBlock.findMany({
    select,
    orderBy: { index: { sort: 'asc', nulls: 'last' } },
    where: ownedOnly
      ? { userId }
      : {
          id: ids ? { in: ids } : undefined,
          OR: [
            {
              // Either the user has custom home blocks of their own,
              // or we return the default Civitai ones (user -1).
              userId: hasCustomHomeBlocks ? userId : -1,
            },
            {
              permanent: true,
            },
          ],
        },
  });
};

export const getSystemHomeBlocks = async ({ input }: { input: GetSystemHomeBlocksInputSchema }) => {
  const homeBlocks = await dbRead.homeBlock.findMany({
    select: {
      id: true,
      metadata: true,
      type: true,
      userId: true,
      index: true,
    },
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
  const homeBlock = await dbRead.homeBlock.findUniqueOrThrow({
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
  items: AsyncReturnType<typeof getCollectionItemsByCollectionId>;
};
type GetShopSectionsWithItems = AsyncReturnType<typeof getShopSectionsWithItems>[number];

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

      const items = input.withCoreData
        ? []
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
          items,
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

      const filteredModelData: typeof validModelData = [];
      const creatorsSeen: Record<number, number> = {};
      const maxEntries = 3;

      validModelData.forEach((md) => {
        const creatorSeen = creatorsSeen[md.user.id] ?? 0;
        if (creatorSeen < maxEntries) {
          filteredModelData.push(md);
          creatorsSeen[md.user.id] = creatorSeen + 1;
        }
      });

      const limitedData = filteredModelData
        .sort((a, b) => {
          const matchA = featured.find((f) => f.modelId === a.id);
          const matchB = featured.find((f) => f.modelId === b.id);
          if (!matchA || !matchA.position) return 1;
          if (!matchB || !matchB.position) return -1;
          return matchA.position - matchB.position;
        })
        .slice(0, input.limit);
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
      select: {
        id: true,
        metadata: true,
        type: true,
      },
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
