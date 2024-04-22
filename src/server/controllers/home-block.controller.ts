import { Context } from '~/server/createContext';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  deleteHomeBlockById,
  getHomeBlockById,
  getHomeBlockData,
  getHomeBlocks,
  getSystemHomeBlocks,
  HomeBlockWithData,
  setHomeBlocksOrder,
  upsertHomeBlock,
} from '~/server/services/home-block.service';
import {
  getCollectionById,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import {
  CreateCollectionHomeBlockInputSchema,
  GetHomeBlockByIdInputSchema,
  GetHomeBlocksInputSchema,
  GetSystemHomeBlocksInputSchema,
  HomeBlockMetaSchema,
  SetHomeBlocksOrderInputSchema,
} from '~/server/schema/home-block.schema';
import { CollectionType, HomeBlockType } from '@prisma/client';
import { GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import { TRPCError } from '@trpc/server';
import { isDefined } from '~/utils/type-guards';

export const getHomeBlocksHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetHomeBlocksInputSchema;
}): Promise<HomeBlockWithData[]> => {
  const { ownedOnly } = input;
  try {
    const homeBlocks = await getHomeBlocks({
      select: {
        id: true,
        metadata: true,
        type: true,
        userId: true,
        sourceId: true,
      },
      userId: ctx.user?.id,
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

export const getSystemHomeBlocksHandler = async ({
  input,
  ctx,
}: {
  input: GetSystemHomeBlocksInputSchema;
  ctx: Context;
}): Promise<HomeBlockWithData[]> => {
  try {
    const homeBlocks = await getSystemHomeBlocks({ input });
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
  input: GetHomeBlockByIdInputSchema & UserPreferencesInput;
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

  const permission = await getUserCollectionPermissionsById({
    id: collection.id,
    isModerator: ctx.user.isModerator,
    userId: ctx.user.id,
  });

  if (!permission.read) {
    throw throwAuthorizationError('You do not have permission to view this collection');
  }

  const metadata: HomeBlockMetaSchema = {
    collection: {
      id: collection.id,
      // Right now this is the standard.
      limit: 8,
      rows: 2,
    },
  };

  await upsertHomeBlock({
    input: {
      type: HomeBlockType.Collection,
      metadata,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    },
  });
};

export const deleteUserHomeBlockHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { id: userId, isModerator } = ctx.user;

  try {
    const homeBlock = await getHomeBlockById({ ...input });
    if (!homeBlock) throw throwNotFoundError(`No home block with id ${input.id}`);

    if (!isModerator && homeBlock.userId !== userId) throw throwAuthorizationError();

    const deleted = await deleteHomeBlockById({
      input: { ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator },
    });

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const setHomeBlocksOrderHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: SetHomeBlocksOrderInputSchema;
}) => {
  try {
    await setHomeBlocksOrder({ input: { ...input, userId: ctx.user.id } });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
