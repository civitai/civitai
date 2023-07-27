import { dbRead, dbWrite } from '~/server/db/client';
import {
  CollectionContributorPermission,
  CollectionReadConfiguration,
  HomeBlockType,
  Prisma,
} from '@prisma/client';
import {
  GetHomeBlockByIdInputSchema,
  GetHomeBlocksInputSchema,
  HomeBlockMetaSchema,
  UpsertHomeBlockInput,
} from '~/server/schema/home-block.schema';
import { UserPreferencesInput } from '~/server/middleware.trpc';
import {
  getCollectionById,
  getCollectionItemsByCollectionId,
} from '~/server/services/collection.service';
import { getLeaderboardsWithResults } from '~/server/services/leaderboard.service';
import { getAnnouncements } from '~/server/services/announcement.service';
import { Context } from '~/server/createContext';
import { SessionUser } from 'next-auth';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import { GetByIdInput } from '~/server/schema/base.schema';

export const getHomeBlocks = async <
  TSelect extends Prisma.HomeBlockSelect = Prisma.HomeBlockSelect
>({
  select,
  ctx,
}: {
  select: TSelect;
  ctx: Context;
}) => {
  const hasCustomHomeBlocks = await userHasCustomHomeBlocks(ctx.user);

  return dbRead.homeBlock.findMany({
    select,
    orderBy: { index: { sort: 'asc', nulls: 'last' } },
    where: {
      OR: [
        {
          // Either the user has custom home blocks of their own,
          // or we return the default Civitai ones (user -1).
          userId: hasCustomHomeBlocks ? ctx.user?.id : -1,
        },
        {
          permanent: true,
        },
      ],
    },
  });
};

export const getCivitaiHomeBlocks = async () => {
  dbRead.homeBlock.findMany({
    select: {
      id: true,
      metadata: true,
      type: true,
    },
    orderBy: { index: { sort: 'asc', nulls: 'last' } },
    where: {
      userId: -1,
    },
  });
};

export const getHomeBlockById = async ({
  id,
  ctx,
  ...input
}: GetHomeBlockByIdInputSchema & { ctx: Context }) => {
  const homeBlock = await dbRead.homeBlock.findUniqueOrThrow({
    select: {
      id: true,
      metadata: true,
      type: true,
    },
    where: {
      id,
    },
  });

  return getHomeBlockData({ homeBlock, ctx, input });
};

export const getHomeBlockData = async ({
  homeBlock,
  ctx,
  input,
}: {
  homeBlock: {
    id: number;
    metadata?: HomeBlockMetaSchema | Prisma.JsonValue;
    type: HomeBlockType;
  };
  ctx: Context;
  input: GetHomeBlocksInputSchema;
}) => {
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

      const items = await getCollectionItemsByCollectionId({
        ctx,
        input: {
          ...(input as UserPreferencesInput),
          collectionId: collection.id,
          // TODO.home-blocks: Set item limit as part of the input?
          limit: metadata.collection.limit,
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
        isModerator: ctx.user?.isModerator || false,
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
    case HomeBlockType.Announcement: {
      if (!metadata.announcements) {
        return null;
      }

      const announcementIds = metadata.announcements.ids;
      const announcements = await getAnnouncements({
        ids: announcementIds,
        dismissed: input.dismissed,
        limit: metadata.announcements.limit,
        user: ctx.user,
      });

      if (!announcements.length) {
        // If the user cleared all announcements in home block, do not display this block.
        return null;
      }

      return {
        ...homeBlock,
        metadata,
        announcements: announcements.sort((a, b) => {
          const aIndex = a.metadata.index ?? 999;
          const bIndex = b.metadata.index ?? 999;

          return aIndex - bIndex;
        }),
      };
    }
    default:
      return { ...homeBlock, metadata };
  }
};

export const userHasCustomHomeBlocks = async (user?: SessionUser) => {
  if (!user) {
    return false;
  }

  const [row]: { exists: boolean }[] = await dbRead.$queryRaw`
    SELECT EXISTS(
        SELECT 1 FROM "HomeBlock" hb WHERE hb."userId"=${user.id} AND hb."sourceId" IS NULL
      )
  `;

  const { exists } = row;

  return exists;
};

export const upsertHomeBlock = async ({
  input,
  ctx,
}: {
  input: UpsertHomeBlockInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { id, metadata, type, sourceId, index } = input;
  const { user } = ctx;

  if (id) {
    const homeBlock = await dbRead.homeBlock.findUnique({
      select: { userId: true },
      where: { id },
    });

    if (!homeBlock) {
      throw throwNotFoundError('Home block not found.');
    }

    if (user.id !== homeBlock.userId && !user.isModerator) {
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

  return dbWrite.homeBlock.create({
    data: {
      metadata,
      type,
      sourceId,
      index,
      userId: user.id,
    },
  });
};

export const deleteHomeBlockById = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = input;
    const homeBlock = await dbRead.homeBlock.findFirst({
      // Confirm the homeBlock belongs to the user:
      where: { id, userId: ctx.user.isModerator ? undefined : ctx.user.id },
      select: { id: true, userId: true },
    });

    if (!homeBlock) {
      return null;
    }

    const isOwner = homeBlock.userId === ctx.user.id;

    const deleteSuccess = await dbWrite.homeBlock.delete({ where: { id } });
    // See if the user has other home blocks:

    if (isOwner) {
      // Check that the user has other collections:
      const hasOtherHomeBlocks = await userHasCustomHomeBlocks(ctx.user);

      if (!hasOtherHomeBlocks) {
        // Delete all cloned collections if any, this will
        // leave them with our default home blocks:
        await dbWrite.homeBlock.deleteMany({ where: { userId: ctx.user.id } });
      }
    }

    return deleteSuccess;
  } catch {
    // Ignore errors
  }
};
