import { Context } from '~/server/createContext';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
  deleteHomeBlockById,
  getHomeBlockById,
  getHomeBlockData,
  getHomeBlocks,
  upsertHomeBlock,
} from '~/server/services/home-block.service';
import {
  getCollectionById,
  getCollectionItemsByCollectionId,
} from '~/server/services/collection.service';
import {
  CreateCollectionHomeBlockInputSchema,
  GetHomeBlockByIdInputSchema,
  GetHomeBlocksInputSchema,
  HomeBlockMetaSchema,
} from '~/server/schema/home-block.schema';
import { getLeaderboardsWithResults } from '~/server/services/leaderboard.service';
import { getAnnouncements } from '~/server/services/announcement.service';
import { HomeBlockType } from '@prisma/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { TRPCError } from '@trpc/server';
import { isDefined } from '~/utils/type-guards';

type GetLeaderboardsWithResults = AsyncReturnType<typeof getLeaderboardsWithResults>;
type GetAnnouncements = AsyncReturnType<typeof getAnnouncements>;
type GetCollectionWithItems = AsyncReturnType<typeof getCollectionById> & {
  items: AsyncReturnType<typeof getCollectionItemsByCollectionId>;
};
type HomeBlockWithData = Omit<AsyncReturnType<typeof getHomeBlocks>[number], 'metadata' | 'id'> & {
  id: number;
  metadata: HomeBlockMetaSchema;
  collection?: GetCollectionWithItems;
  leaderboards?: GetLeaderboardsWithResults;
  announcements?: GetAnnouncements;
};

export const getHomeBlocksHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetHomeBlocksInputSchema;
}): Promise<HomeBlockWithData[]> => {
  const { ownedOnly } = input || {};
  try {
    const homeBlocks = await getHomeBlocks({
      select: {
        id: true,
        metadata: true,
        type: true,
        userId: true,
      },
      user: ctx.user,
      ownedOnly,
    });

    if (input.withCoreData) {
      // Get the core data for each home block:
      const homeBlocksWithData = await Promise.all(
        homeBlocks.map((homeBlock) => {
          return getHomeBlockData({ homeBlock, user: ctx.user, input });
        })
      );

      return homeBlocksWithData.filter(isDefined);
    }

    return homeBlocks.map((homeBlock) => ({
      ...homeBlock,
      metadata: homeBlock.metadata as HomeBlockMetaSchema,
    }));
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getHomeBlocksByIdHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetHomeBlockByIdInputSchema;
}): Promise<HomeBlockWithData> => {
  try {
    const homeBlock = await getHomeBlockById({
      ...input,
      user: ctx.user,
    });

    if (!homeBlock) {
      throw throwNotFoundError('Home block not found');
    }

    return homeBlock;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const createCollectionHomeBlockHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: CreateCollectionHomeBlockInputSchema;
}) => {
  const collection = await getCollectionById({ input: { id: input.collectionId } });

  if (!collection) {
    throw throwNotFoundError('Collection not found');
  }

  const metadata: HomeBlockMetaSchema = {
    collection: {
      id: collection.id,
      // Right now this is the standard.
      limit: 8,
    },
  };

  await upsertHomeBlock({
    input: {
      type: HomeBlockType.Collection,
      metadata,
    },
    user: ctx.user,
  });
};

export const deleteUserHomeBlockHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    await deleteHomeBlockById({ input, user: ctx.user });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
