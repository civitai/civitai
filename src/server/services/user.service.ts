import { Prisma } from '@prisma/client';

import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetAllUsersInput, GetUserByUsernameSchema } from '~/server/schema/user.schema';

//https://github.com/civitai/civitai/discussions/8
export const getUserModelStats = async ({
  input: { username },
}: {
  input: GetUserByUsernameSchema;
}) => {
  const modelRanks = await prisma.modelRank.findMany({
    where: { model: { user: { username } } },
    select: {
      ratingAllTime: true,
      ratingCountAllTime: true,
      downloadCountAllTime: true,
    },
  });

  const ratings = modelRanks.reduce<number[]>(
    (acc, rank) => [...Array(rank.ratingCountAllTime)].map(() => rank.ratingAllTime).concat(acc),
    []
  );
  const avgRating = ratings.reduce((a, b) => a + b) / ratings.length;
  const totalDownloads = modelRanks.reduce((acc, val) => acc + val.downloadCountAllTime, 0);

  return {
    avgRating,
    totalDownloads,
  };
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
  return prisma.model.findUnique({
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
