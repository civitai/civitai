import { throwNotFoundError } from '~/server/utils/errorHandling';
import { ModelEngagementType, Prisma, TagEngagementType } from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  DeleteUserInput,
  GetAllUsersInput,
  GetByUsernameSchema,
  GetUserCosmeticsSchema,
  ToggleBlockedTagSchema,
} from '~/server/schema/user.schema';
import { invalidateSession } from '~/server/utils/session-helpers';
import { env } from '~/env/server.mjs';

// const xprisma = prisma.$extends({
//   result: {
//     user
//   }
// })

export const getUserCreator = async (where: { username?: string; id?: number }) => {
  if (!where.username && !where.id) {
    throw new Error('Must provide username or id');
  }

  return dbRead.user.findFirst({
    where: { ...where, deletedAt: null },
    select: {
      id: true,
      image: true,
      username: true,
      muted: true,
      bannedAt: true,
      createdAt: true,
      links: {
        select: {
          url: true,
          type: true,
        },
      },
      stats: {
        select: {
          ratingAllTime: true,
          ratingCountAllTime: true,
          downloadCountAllTime: true,
          favoriteCountAllTime: true,
          followerCountAllTime: true,
        },
      },
      rank: { select: { leaderboardRank: true } },
      cosmetics: {
        where: { equippedAt: { not: null } },
        select: {
          cosmetic: {
            select: {
              id: true,
              data: true,
              type: true,
              source: true,
              name: true,
            },
          },
        },
      },
      _count: {
        select: {
          models: {
            where: { status: 'Published' },
          },
        },
      },
    },
  });
};

export const getUsers = <TSelect extends Prisma.UserSelect = Prisma.UserSelect>({
  limit,
  query,
  email,
  select,
  ids,
}: GetAllUsersInput & { select: TSelect }) => {
  return dbRead.user.findMany({
    take: limit,
    select,
    where: {
      id: ids && ids.length > 0 ? { in: ids } : undefined,
      username: query
        ? {
            contains: query,
            mode: 'insensitive',
          }
        : undefined,
      email: email,
      deletedAt: null,
    },
  });
};

export const getUserById = <TSelect extends Prisma.UserSelect = Prisma.UserSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return dbRead.user.findUnique({
    where: { id },
    select,
  });
};

export const getUserByUsername = <TSelect extends Prisma.UserSelect = Prisma.UserSelect>({
  username,
  select,
}: GetByUsernameSchema & { select: TSelect }) => {
  return dbRead.user.findUnique({
    where: { username },
    select,
  });
};

export const updateUserById = ({ id, data }: { id: number; data: Prisma.UserUpdateInput }) => {
  return dbWrite.user.update({ where: { id }, data });
};

export const getUserEngagedModels = ({ id }: { id: number }) => {
  return dbRead.user.findUnique({
    where: { id },
    select: { engagedModels: { select: { modelId: true, type: true } } },
  });
};

export const getUserEngagedModelVersions = ({ id }: { id: number }) => {
  return dbRead.user.findUnique({
    where: { id },
    select: { engagedModelVersions: { select: { modelVersionId: true, type: true } } },
  });
};

export const getUserEngagedModelByModelId = ({
  userId,
  modelId,
}: {
  userId: number;
  modelId: number;
}) => {
  return dbRead.modelEngagement.findUnique({ where: { userId_modelId: { userId, modelId } } });
};

export const getUserTags = ({ userId, type }: { userId: number; type?: TagEngagementType }) => {
  return dbRead.tagEngagement.findMany({ where: { userId, type } });
};

export const getCreators = async <TSelect extends Prisma.UserSelect>({
  query,
  take,
  skip,
  select,
  orderBy,
  excludeIds = [],
  count = false,
}: {
  select: TSelect;
  query?: string;
  take?: number;
  skip?: number;
  count?: boolean;
  orderBy?: Prisma.UserFindManyArgs['orderBy'];
  excludeIds?: number[];
}) => {
  const where: Prisma.UserWhereInput = {
    username: query
      ? {
          contains: query,
          mode: 'insensitive',
        }
      : undefined,
    models: { some: {} },
    id: excludeIds.length ? { notIn: excludeIds } : undefined,
    deletedAt: null,
  };
  const items = await dbRead.user.findMany({
    take,
    skip,
    select,
    where,
    orderBy,
  });

  if (count) {
    const count = await dbRead.user.count({ where });
    return { items, count };
  }

  return { items };
};

export const getUserUnreadNotificationsCount = ({ id }: { id: number }) => {
  return dbRead.user.findUnique({
    where: { id },
    select: {
      _count: {
        select: { notifications: { where: { viewedAt: { equals: null } } } },
      },
    },
  });
};

export const toggleModelEngagement = async ({
  userId,
  modelId,
  type,
}: {
  userId: number;
  modelId: number;
  type: ModelEngagementType;
}) => {
  const engagement = await dbWrite.modelEngagement.findUnique({
    where: { userId_modelId: { userId, modelId } },
    select: { type: true },
  });

  if (engagement) {
    if (engagement.type === type)
      await dbWrite.modelEngagement.delete({
        where: { userId_modelId: { userId, modelId } },
      });
    else if (engagement.type !== type)
      await dbWrite.modelEngagement.update({
        where: { userId_modelId: { userId, modelId } },
        data: { type, createdAt: new Date() },
      });

    return;
  }

  await dbWrite.modelEngagement.create({ data: { type, modelId, userId } });
  return;
};

export const toggleModelFavorite = async ({
  userId,
  modelId,
}: {
  userId: number;
  modelId: number;
}) => toggleModelEngagement({ userId, modelId, type: 'Favorite' });

export const toggleModelHide = async ({ userId, modelId }: { userId: number; modelId: number }) =>
  toggleModelEngagement({ userId, modelId, type: 'Hide' });

export const toggleFollowUser = async ({
  userId,
  targetUserId,
}: {
  userId: number;
  targetUserId: number;
}) => {
  const engagement = await dbWrite.userEngagement.findUnique({
    where: { userId_targetUserId: { targetUserId, userId } },
    select: { type: true },
  });

  if (engagement) {
    if (engagement.type === 'Follow')
      await dbWrite.userEngagement.delete({
        where: { userId_targetUserId: { userId, targetUserId } },
      });
    else if (engagement.type === 'Hide')
      await dbWrite.userEngagement.update({
        where: { userId_targetUserId: { userId, targetUserId } },
        data: { type: 'Follow' },
      });

    return;
  }

  await dbWrite.userEngagement.create({ data: { type: 'Follow', targetUserId, userId } });
  return;
};

export const toggleHideUser = async ({
  userId,
  targetUserId,
}: {
  userId: number;
  targetUserId: number;
}) => {
  const engagement = await dbWrite.userEngagement.findUnique({
    where: { userId_targetUserId: { targetUserId, userId } },
    select: { type: true },
  });

  if (engagement) {
    if (engagement.type === 'Hide')
      await dbWrite.userEngagement.delete({
        where: { userId_targetUserId: { userId, targetUserId } },
      });
    else if (engagement.type === 'Follow')
      await dbWrite.userEngagement.update({
        where: { userId_targetUserId: { userId, targetUserId } },
        data: { type: 'Hide' },
      });

    return;
  }

  await dbWrite.userEngagement.create({ data: { type: 'Hide', targetUserId, userId } });
  return;
};

export const deleteUser = async ({ id, username, removeModels }: DeleteUserInput) => {
  const user = await dbWrite.user.findFirst({
    where: { username, id },
    select: { id: true },
  });
  if (!user) throw throwNotFoundError('Could not find user');

  const modelData: Prisma.ModelUpdateManyArgs['data'] = removeModels
    ? { deletedAt: new Date(), status: 'Deleted' }
    : { userId: -1 };

  const result = await dbWrite.$transaction([
    dbWrite.model.updateMany({ where: { userId: user.id }, data: modelData }),
    dbWrite.account.deleteMany({ where: { userId: user.id } }),
    dbWrite.session.deleteMany({ where: { userId: user.id } }),
    dbWrite.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date(), email: null, username: null },
    }),
  ]);
  await invalidateSession(id);
  return result;
};

export const toggleBlockedTag = async ({
  tagId,
  userId,
}: ToggleBlockedTagSchema & { userId: number }) => {
  const matchedTag = await dbWrite.tagEngagement.findUnique({
    where: { userId_tagId: { userId, tagId } },
    select: { type: true },
  });

  if (matchedTag) {
    if (matchedTag.type === 'Hide')
      return dbWrite.tagEngagement.delete({
        where: { userId_tagId: { userId, tagId } },
      });
    else if (matchedTag.type === 'Follow')
      return dbWrite.tagEngagement.update({
        where: { userId_tagId: { userId, tagId } },
        data: { type: 'Hide' },
      });
  }

  return dbWrite.tagEngagement.create({ data: { userId, tagId, type: 'Hide' } });
};

export const updateAccountScope = async ({
  providerAccountId,
  provider,
  scope,
}: {
  providerAccountId: string;
  provider: string;
  scope?: string;
}) => {
  if (!scope) return;

  const account = await dbWrite.account.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId } },
    select: { id: true, scope: true },
  });
  if (account && !!account.scope) {
    const currentScope = account.scope.split(' ');
    const hasNewScope = scope?.split(' ').some((s) => !currentScope.includes(s));
    if (hasNewScope) await dbWrite.account.update({ where: { id: account.id }, data: { scope } });
  }
};

export const getSessionUser = async ({ userId, token }: { userId?: number; token?: string }) => {
  if (!userId && !token) return undefined;
  const where: Prisma.UserWhereInput = { deletedAt: null };
  if (userId) where.id = userId;
  else if (token) where.keys = { some: { key: token } };

  const user = await dbWrite.user.findFirst({
    where,
    include: {
      subscription: { select: { status: true, product: { select: { metadata: true } } } },
    },
  });

  if (!user) return undefined;

  const { subscription, ...rest } = user;
  const tier: string | undefined =
    subscription && subscription.status === 'active'
      ? (subscription.product.metadata as any)[env.STRIPE_METADATA_KEY]
      : undefined;

  return { ...rest, tier };
};

export const getUserCosmetics = ({
  userId,
  equipped,
}: GetUserCosmeticsSchema & { userId: number }) => {
  return dbRead.user.findUnique({
    where: { id: userId },
    select: {
      cosmetics: {
        where: equipped ? { equippedAt: { not: null } } : undefined,
        select: {
          obtainedAt: true,
          cosmetic: {
            select: {
              id: true,
              name: true,
              description: true,
              type: true,
              source: true,
              data: true,
            },
          },
        },
      },
    },
  });
};
