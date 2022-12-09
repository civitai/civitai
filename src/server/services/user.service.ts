import { Prisma } from '@prisma/client';

import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetAllUsersInput } from '~/server/schema/user.schema';

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
      rank: {
        select: {
          ratingAllTime: true,
          ratingCountAllTime: true,
          downloadCountAllTime: true,
          favoriteCountAllTime: true,
        },
      },
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
}: GetAllUsersInput & { select: TSelect }) => {
  return prisma.user.findMany({
    take: limit,
    select,
    where: {
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

export const updateUserById = ({ id, data }: { id: number; data: Prisma.UserUpdateInput }) => {
  return prisma.user.update({ where: { id }, data });
};

export const deleteUser = ({ id }: GetByIdInput) => {
  return prisma.user.delete({ where: { id } });
};

export const getUserFavoriteModels = ({ id }: { id: number }) => {
  return prisma.user.findUnique({
    where: { id },
    select: { favoriteModels: { select: { modelId: true } } },
  });
};

export const getUserFavoriteModelByModelId = ({
  userId,
  modelId,
}: {
  userId: number;
  modelId: number;
}) => {
  return prisma.favoriteModel.findUnique({ where: { userId_modelId: { userId, modelId } } });
};

export const getCreators = async <TSelect extends Prisma.UserSelect>({
  query,
  take,
  skip,
  select,
  count = false,
}: {
  select: TSelect;
  query?: string;
  take?: number;
  skip?: number;
  count?: boolean;
}) => {
  const where: Prisma.UserWhereInput = {
    username: query
      ? {
          contains: query,
          mode: 'insensitive',
        }
      : undefined,
    models: { some: {} },
  };
  const items = await prisma.user.findMany({
    take,
    skip,
    select,
    where,
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
