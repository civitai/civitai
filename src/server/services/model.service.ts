import { SessionUser } from 'next-auth';
import { GetAllModelsArgs } from './../schema/model.schema';
import { prisma } from '~/server/db/client';
import { ModelStatus } from '@prisma/client';
import { ModelSort } from '~/server/common/enums';

export const getAllModels = async (
  { limit, page, cursor, query, tag, user, types, sort, period }: GetAllModelsArgs,
  sessionUser: SessionUser
) => {
  const take = limit ?? 10;
  const skip = page ? (page - 1) * take : undefined;
  const canViewNsfw = sessionUser.showNsfw ?? true;

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
      OR: !sessionUser?.isModerator
        ? [{ status: ModelStatus.Published }, { user: { id: sessionUser.id } }]
        : undefined,
    },
    orderBy: [
      ...(sort === ModelSort.HighestRated
        ? [
            {
              rank: {
                [`rating${period}Rank`]: 'asc',
              },
            },
          ]
        : []),
      ...(sort === ModelSort.MostDownloaded
        ? [
            {
              rank: {
                [`downloadCount${period}Rank`]: 'asc',
              },
            },
          ]
        : []),
      { createdAt: 'desc' },
    ],
  });
};
