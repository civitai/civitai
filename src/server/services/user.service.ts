import { throwNotFoundError } from '~/server/utils/errorHandling';
import { ModelEngagementType, Prisma, TagEngagementType } from '@prisma/client';

import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  DeleteUserInput,
  GetAllUsersInput,
  GetByUsernameSchema,
  ToggleBlockedTagSchema,
} from '~/server/schema/user.schema';

// const xprisma = prisma.$extends({
//   result: {
//     user
//   }
// })

export const getUserCreator = async ({ username }: { username: string }) => {
  return prisma.user.findFirst({
    where: { username },
    select: {
      id: true,
      image: true,
      username: true,
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
      _count: {
        select: {
          models: true,
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
  return prisma.user.findMany({
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
    },
  });
};

export const getUserById = <TSelect extends Prisma.UserSelect = Prisma.UserSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return prisma.user.findUnique({
    where: { id },
    select,
  });
};

export const getUserByUsername = <TSelect extends Prisma.UserSelect = Prisma.UserSelect>({
  username,
  select,
}: GetByUsernameSchema & { select: TSelect }) => {
  return prisma.user.findUnique({
    where: { username },
    select,
  });
};

export const updateUserById = ({ id, data }: { id: number; data: Prisma.UserUpdateInput }) => {
  return prisma.user.update({ where: { id }, data });
};

export const getUserEngagedModels = ({ id }: { id: number }) => {
  return prisma.user.findUnique({
    where: { id },
    select: { engagedModels: { select: { modelId: true, type: true } } },
  });
};

export const getUserEngagedModelByModelId = ({
  userId,
  modelId,
}: {
  userId: number;
  modelId: number;
}) => {
  return prisma.modelEngagement.findUnique({ where: { userId_modelId: { userId, modelId } } });
};

export const getUserTags = ({ userId, type }: { userId: number; type?: TagEngagementType }) => {
  return prisma.tagEngagement.findMany({ where: { userId, type } });
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
  };
  const items = await prisma.user.findMany({
    take,
    skip,
    select,
    where,
    orderBy,
  });

  if (count) {
    const count = await prisma.user.count({ where });
    return { items, count };
  }

  return { items };
};

export const getUserUnreadNotificationsCount = ({ id }: { id: number }) => {
  return prisma.user.findUnique({
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
  const engagement = await prisma.modelEngagement.findUnique({
    where: { userId_modelId: { userId, modelId } },
    select: { type: true },
  });
  console.log(engagement?.type, type);

  if (engagement) {
    if (engagement.type === type)
      await prisma.modelEngagement.delete({
        where: { userId_modelId: { userId, modelId } },
      });
    else if (engagement.type !== type)
      await prisma.modelEngagement.update({
        where: { userId_modelId: { userId, modelId } },
        data: { type, createdAt: new Date() },
      });

    return;
  }

  await prisma.modelEngagement.create({ data: { type, modelId, userId } });
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
  const engagement = await prisma.userEngagement.findUnique({
    where: { userId_targetUserId: { targetUserId, userId } },
    select: { type: true },
  });

  if (engagement) {
    if (engagement.type === 'Follow')
      await prisma.userEngagement.delete({
        where: { userId_targetUserId: { userId, targetUserId } },
      });
    else if (engagement.type === 'Hide')
      await prisma.userEngagement.update({
        where: { userId_targetUserId: { userId, targetUserId } },
        data: { type: 'Follow' },
      });

    return;
  }

  await prisma.userEngagement.create({ data: { type: 'Follow', targetUserId, userId } });
  return;
};

export const toggleHideUser = async ({
  userId,
  targetUserId,
}: {
  userId: number;
  targetUserId: number;
}) => {
  const engagement = await prisma.userEngagement.findUnique({
    where: { userId_targetUserId: { targetUserId, userId } },
    select: { type: true },
  });

  if (engagement) {
    if (engagement.type === 'Hide')
      await prisma.userEngagement.delete({
        where: { userId_targetUserId: { userId, targetUserId } },
      });
    else if (engagement.type === 'Follow')
      await prisma.userEngagement.update({
        where: { userId_targetUserId: { userId, targetUserId } },
        data: { type: 'Hide' },
      });

    return;
  }

  await prisma.userEngagement.create({ data: { type: 'Hide', targetUserId, userId } });
  return;
};

export const deleteUser = async ({ id, username, removeModels }: DeleteUserInput) => {
  const user = await prisma.user.findFirst({
    where: { username, id },
    select: { id: true },
  });
  if (!user) throw throwNotFoundError('Could not find user');
  if (removeModels) {
    await prisma.model.deleteMany({ where: { userId: user.id } });
  }
  return await prisma.user.delete({ where: { id: user.id } });
};

export const toggleBlockedTag = async ({
  tagId,
  userId,
}: ToggleBlockedTagSchema & { userId: number }) => {
  const matchedTag = await prisma.tagEngagement.findUnique({
    where: { userId_tagId: { userId, tagId } },
    select: { type: true },
  });

  if (matchedTag) {
    if (matchedTag.type === 'Hide')
      return prisma.tagEngagement.delete({
        where: { userId_tagId: { userId, tagId } },
      });
    else if (matchedTag.type === 'Follow')
      return prisma.tagEngagement.update({
        where: { userId_tagId: { userId, tagId } },
        data: { type: 'Hide' },
      });
  }

  return prisma.tagEngagement.create({ data: { userId, tagId, type: 'Hide' } });
};
