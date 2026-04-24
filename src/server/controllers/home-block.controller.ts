import type { Context } from '~/server/createContext';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { HomeBlockWithData } from '~/server/services/home-block.service';
import {
  acknowledgeFeaturedCollectionName,
  addCollectionToFeaturedPool,
  deleteHomeBlockById,
  getFeaturedCollectionsPool,
  getHomeBlockById,
  getHomeBlockData,
  getHomeBlocks,
  getSystemHomeBlocks,
  removeCollectionFromFeaturedPool,
  setHomeBlocksOrder,
  upsertHomeBlock,
} from '~/server/services/home-block.service';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import { getFeaturedCollectionsState } from '~/server/jobs/refresh-featured-collections-eligibility';
import { dbRead } from '~/server/db/client';
import {
  getCollectionById,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import type {
  CreateCollectionHomeBlockInputSchema,
  GetHomeBlockByIdInputSchema,
  GetHomeBlocksInputSchema,
  GetSystemHomeBlocksInputSchema,
  HomeBlockMetaSchema,
  SetHomeBlocksOrderInputSchema,
  ToggleFeaturedCollectionInputSchema,
} from '~/server/schema/home-block.schema';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import type { GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import { TRPCError } from '@trpc/server';
import { isDefined } from '~/utils/type-guards';

export const getHomeBlocksHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetHomeBlocksInputSchema;
}): Promise<HomeBlockWithData[]> => {
  const { ownedOnly, excludedSystemHomeBlockIds = [], systemHomeBlockIds } = input;

  try {
    const _homeBlocks = await getHomeBlocks({
      userId: ctx.user?.id,
      ownedOnly,
      includeSource: true,
    });

    let homeBlocks = _homeBlocks.filter((homeBlock) => {
      if ((excludedSystemHomeBlockIds ?? []).includes(homeBlock.id)) {
        return false;
      }

      if ((systemHomeBlockIds ?? []).length === 0) {
        return true; // Always allow.
      }

      // Now check if it's a system home block and the domain allows to show it:
      if (homeBlock.userId === -1 || ('source' in homeBlock && homeBlock.source?.userId === -1)) {
        return (systemHomeBlockIds ?? []).includes(homeBlock.id);
      }

      return true;
    });

    // User might be on a diff. domain that doesn't allow their blocks and we should be able to figure this one out on our end:
    if (homeBlocks.length === 0 && systemHomeBlockIds) {
      homeBlocks = await getHomeBlocks({
        ids: systemHomeBlockIds,
        includeSource: true,
      });
    }

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
    const { excludedSystemHomeBlockIds, systemHomeBlockIds } = input;
    const _homeBlocks = await getSystemHomeBlocks({ input });

    const homeBlocks = _homeBlocks.filter((homeBlock) => {
      if ((excludedSystemHomeBlockIds ?? []).includes(homeBlock.id)) {
        return false;
      }

      if ((systemHomeBlockIds ?? []).length === 0) {
        return true; // Always allow.
      }

      // Now check if it's a system home block and the domain allows to show it:
      return (systemHomeBlockIds ?? []).includes(homeBlock.id);
    });
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
  input: GetHomeBlockByIdInputSchema & UserPreferencesInput;
}): Promise<HomeBlockWithData> => {
  try {
    const homeBlock = await getHomeBlockById({
      ...input,
      user: ctx.user,
    });

    if (homeBlock?.type === 'Announcement') ctx.cache.skip = true;

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

export const getFeaturedCollectionsPoolHandler = async () => {
  try {
    const pool = await getFeaturedCollectionsPool();
    const state = await getFeaturedCollectionsState();
    if (pool.collectionIds.length === 0) {
      return {
        homeBlockId: pool.homeBlockId,
        collections: [],
        stateComputedAt: state?.computedAt ?? null,
      };
    }
    const collections = await dbRead.collection.findMany({
      where: { id: { in: pool.collectionIds } },
      select: {
        id: true,
        name: true,
        nsfwLevel: true,
        type: true,
        image: { select: { id: true, url: true, nsfwLevel: true } },
        user: { select: { id: true, username: true } },
        _count: { select: { items: true } },
      },
    });
    const snapshots = pool.metadata.featuredCollections?.nameSnapshots ?? {};
    const byId = new Map(collections.map((c) => [c.id, c]));
    const ordered = pool.collectionIds.map((id) => {
      const c = byId.get(id);
      const entry = state?.perCollection[id];
      if (!c) {
        // Ghost entry — collection deleted or no longer accessible. Surface it so mods can
        // remove the dangling id from the pool. `missing: true` is the UI's cue.
        return {
          id,
          name: snapshots[id] ?? `Collection ${id}`,
          nsfwLevel: 0,
          type: null,
          image: null,
          user: { id: -1, username: null },
          _count: { items: 0 },
          approvedName: snapshots[id] ?? null,
          recentCount: 0,
          lastAcceptedAt: null,
          nameChanged: false,
          eligible: false,
          missing: true as const,
        };
      }
      return {
        ...c,
        approvedName: snapshots[id] ?? c.name,
        recentCount: entry?.recentCount ?? 0,
        lastAcceptedAt: entry?.lastAcceptedAt ?? null,
        nameChanged: entry?.nameChanged ?? false,
        eligible: entry?.eligible ?? false,
        missing: false as const,
      };
    });
    return {
      homeBlockId: pool.homeBlockId,
      collections: ordered,
      stateComputedAt: state?.computedAt ?? null,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

async function bustFeaturedCollectionsCache(homeBlockId: number) {
  await homeBlockCacheBust(HomeBlockType.FeaturedCollections, homeBlockId);
}

export const addCollectionToFeaturedPoolHandler = async ({
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: ToggleFeaturedCollectionInputSchema;
}) => {
  try {
    const result = await addCollectionToFeaturedPool({ collectionId: input.collectionId });
    await bustFeaturedCollectionsCache(result.homeBlockId);
    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const removeCollectionFromFeaturedPoolHandler = async ({
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: ToggleFeaturedCollectionInputSchema;
}) => {
  try {
    const result = await removeCollectionFromFeaturedPool({ collectionId: input.collectionId });
    await bustFeaturedCollectionsCache(result.homeBlockId);
    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const acknowledgeFeaturedCollectionNameHandler = async ({
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: ToggleFeaturedCollectionInputSchema;
}) => {
  try {
    const result = await acknowledgeFeaturedCollectionName({ collectionId: input.collectionId });
    await bustFeaturedCollectionsCache(result.homeBlockId);
    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
