import { Context } from '~/server/createContext';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
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
import { isDefined } from '~/utils/type-guards';
import { getLeaderboardsWithResults } from '~/server/services/leaderboard.service';
import { getAnnouncements } from '~/server/services/announcement.service';
import { HomeBlockType } from '@prisma/client';

type GetLeaderboardsWithResults = AsyncReturnType<typeof getLeaderboardsWithResults>;
type GetAnnouncements = AsyncReturnType<typeof getAnnouncements>;
type GetCollectionWithItems = AsyncReturnType<typeof getCollectionById> & {
  items: AsyncReturnType<typeof getCollectionItemsByCollectionId>;
};
type HomeBlockWithData = Omit<AsyncReturnType<typeof getHomeBlocks>[number], 'metadata'> & {
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
}) => {
  try {
    const homeBlocks = await getHomeBlocks({
      select: {
        id: true,
        metadata: true,
        type: true,
      },
      ctx,
    });

    return homeBlocks;
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
      ctx,
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
    ctx,
  });
};
