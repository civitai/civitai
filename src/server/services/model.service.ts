import { MetricTimeframe, ModelStatus, Prisma, ReportReason } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { ModelSort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput, ReportInput } from '~/server/schema/base.schema';

import { GetAllModelsOutput } from '../schema/model.schema';

export const getModel = async <TSelect extends Prisma.ModelSelect>({
  input: { id },
  user,
  select,
}: {
  input: GetByIdInput;
  user?: SessionUser;
  select: TSelect;
}) => {
  return await prisma.model.findFirst({
    where: {
      id,
      OR: !user?.isModerator
        ? [{ status: ModelStatus.Published }, { user: { id: user?.id } }]
        : undefined,
    },
    select,
  });
};

export const getModels = async <TSelect extends Prisma.ModelSelect>({
  input: {
    take,
    skip,
    cursor,
    query,
    tag,
    tagname,
    user,
    username,
    types,
    sort,
    period = MetricTimeframe.AllTime,
    rating,
    favorites,
  },
  select,
  user: sessionUser,
  count = false,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & { take?: number; skip?: number };
  select: TSelect;
  user?: SessionUser;
  count?: boolean;
}) => {
  const canViewNsfw = sessionUser?.showNsfw ?? true;
  const where: Prisma.ModelWhereInput = {
    name: query ? { contains: query, mode: 'insensitive' } : undefined,
    tagsOnModels:
      tagname ?? tag
        ? { some: { tag: { name: { equals: tagname ?? tag, mode: 'insensitive' } } } }
        : undefined,
    user: username ?? user ? { username: username ?? user } : undefined,
    type: types?.length ? { in: types } : undefined,
    nsfw: !canViewNsfw ? { equals: false } : undefined,
    rank: rating
      ? {
          AND: [{ ratingAllTime: { gte: rating } }, { ratingAllTime: { lt: rating + 1 } }],
        }
      : undefined,
    OR: !sessionUser?.isModerator
      ? [{ status: ModelStatus.Published }, { user: { id: sessionUser?.id } }]
      : undefined,
    favoriteModels: favorites ? { some: { userId: sessionUser?.id } } : undefined,
  };

  const items = await prisma.model.findMany({
    take,
    skip,
    where,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy: [
      ...(sort === ModelSort.HighestRated ? [{ rank: { [`rating${period}Rank`]: 'asc' } }] : []),
      ...(sort === ModelSort.MostLiked
        ? [{ rank: { [`favoriteCount${period}Rank`]: 'asc' } }]
        : []),
      ...(sort === ModelSort.MostDownloaded
        ? [{ rank: { [`downloadCount${period}Rank`]: 'asc' } }]
        : []),
      ...(sort === ModelSort.MostDiscussed
        ? [{ rank: { [`commentCount${period}Rank`]: 'asc' } }]
        : []),
      { createdAt: 'desc' },
    ],
    select,
  });

  if (count) {
    const count = await prisma.model.count({ where });
    return { items, count };
  }

  return { items };
};

export const getModelVersionsMicro = ({ id }: { id: number }) => {
  return prisma.modelVersion.findMany({
    where: { modelId: id },
    orderBy: { index: 'asc' },
    select: { id: true, name: true },
  });
};

export const updateModelById = ({ id, data }: { id: number; data: Prisma.ModelUpdateInput }) => {
  return prisma.model.update({
    where: { id },
    data,
  });
};

export const reportModelById = ({ id, reason, userId }: ReportInput & { userId: number }) => {
  const data: Prisma.ModelUpdateInput =
    reason === ReportReason.NSFW ? { nsfw: true } : { tosViolation: true };

  return prisma.$transaction([
    updateModelById({ id, data }),
    prisma.modelReport.create({
      data: {
        modelId: id,
        reason,
        userId,
      },
    }),
  ]);
};

export const deleteModelById = ({ id }: GetByIdInput) => {
  return prisma.model.delete({ where: { id } });
};
