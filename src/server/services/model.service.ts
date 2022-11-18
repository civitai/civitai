import { SessionUser } from 'next-auth';
import { GetAllModelsInput } from './../schema/model.schema';
import { prisma } from '~/server/db/client';
import { ModelStatus, Prisma } from '@prisma/client';
import { ModelSort } from '~/server/common/enums';
import { GetByIdInput } from '~/server/schema/base.schema';

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
  input: { limit, page, cursor, query, tag, user, types, sort, period },
  user: sessionUser,
  select,
}: {
  input: GetAllModelsInput;
  user?: SessionUser;
  select: TSelect;
}) => {
  const take = limit ?? 10;
  const skip = page ? (page - 1) * take : undefined;
  const canViewNsfw = sessionUser?.showNsfw ?? true;

  return await prisma.model.findMany({
    take: cursor ? take + 1 : take,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      name: query ? { contains: query, mode: 'insensitive' } : undefined,
      tagsOnModels: tag ? { some: { tag: { name: tag } } } : undefined,
      user: user ? { username: user } : undefined,
      type: types ? { in: types } : undefined,
      nsfw: !canViewNsfw ? { equals: false } : undefined,
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
