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
    limit,
    page,
    cursor,
    query,
    tag,
    user,
    types,
    sort,
    period = MetricTimeframe.AllTime,
    rating,
  },
  user: sessionUser,
  select,
}: {
  input: GetAllModelsOutput;
  user?: SessionUser;
  select: TSelect;
}) => {
  const take = limit ?? 10;
  const skip = page ? (page - 1) * take : undefined;
  const canViewNsfw = sessionUser?.showNsfw ?? true;

  return await prisma.model.findMany({
    take,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      name: query ? { contains: query, mode: 'insensitive' } : undefined,
      tagsOnModels: tag ? { some: { tag: { name: tag } } } : undefined,
      user: user ? { username: user } : undefined,
      type: types ? { in: types } : undefined,
      nsfw: !canViewNsfw ? { equals: false } : undefined,
      rank: rating
        ? {
            AND: [{ ratingAllTime: { gte: rating } }, { ratingAllTime: { lt: rating + 1 } }],
          }
        : undefined,
      OR: !sessionUser?.isModerator
        ? [{ status: ModelStatus.Published }, { user: { id: sessionUser?.id } }]
        : undefined,
    },
    orderBy: [
      ...(sort === ModelSort.HighestRated ? [{ rank: { [`rating${period}Rank`]: 'asc' } }] : []),
      ...(sort === ModelSort.MostDownloaded
        ? [{ rank: { [`downloadCount${period}Rank`]: 'asc' } }]
        : []),
      { createdAt: 'desc' },
    ],
    select,
  });
};

export const getModelVersionsMicro = ({ id }: { id: number }) => {
  return prisma.modelVersion.findMany({
    where: { modelId: id },
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
