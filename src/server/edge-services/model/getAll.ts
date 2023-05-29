import { SessionUser } from 'next-auth';
import { GetAllOutput } from './schemas';
import { MetricTimeframe, ModelStatus, Prisma } from '@prisma/client';
import { ModelSort } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { decreaseDate } from '~/utils/date-helpers';
import { ManipulateType } from 'dayjs';
import { getShowNsfw } from '~/server/edge-services/edge-services.utils';

export const getAll = async <TSelect extends Prisma.ModelSelect>(
  {
    take,
    cursor,
    query,
    tags,
    tagname,
    user,
    username = user,
    types,
    status,
    checkpointType,
    baseModels,
    sort,
    period,
    periodMode,
    rating,
    favorites,
    hidden,
    needsReview,
    earlyAccess,
    currentUser,
  }: GetAllOutput & { currentUser?: SessionUser },
  select: TSelect
) => {
  // const showNsfw = getShowNsfw(browsingMode, currentUser);
  const lowerQuery = query?.toLowerCase();
  const AND: Prisma.Enumerable<Prisma.ModelWhereInput> = [];

  // #region [WHERE]
  if (currentUser?.isModerator) {
    if (status?.includes(ModelStatus.Unpublished)) status.push(ModelStatus.UnpublishedViolation);
    AND.push({ status: !!status?.length ? { in: status } : ModelStatus.Published });
  } else {
    // only return published models
    const statusVisibleOr: Prisma.Enumerable<Prisma.ModelWhereInput> = [
      { status: ModelStatus.Published },
    ];
    // allows the current user to view their draft models
    if (currentUser && (username || user)) {
      statusVisibleOr.push({
        AND: [{ user: { id: currentUser.id } }, { status: ModelStatus.Draft }],
      });
    }
    AND.push({ OR: statusVisibleOr });
  }

  if (query) {
    AND.push({
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        {
          modelVersions: {
            some: {
              OR: [
                {
                  files: {
                    some: {
                      hashes: { some: { hash: query } },
                    },
                  },
                },
                {
                  trainedWords: { has: lowerQuery },
                },
              ],
            },
          },
        },
      ],
    });
  }

  // if (!showNsfw) AND.push({ nsfw: false });

  if (checkpointType && (!types?.length || types?.includes('Checkpoint'))) {
    const TypeOr: Prisma.Enumerable<Prisma.ModelWhereInput> = [{ checkpointType }];
    if (types?.length) {
      const otherTypes = types.filter((t) => t !== 'Checkpoint');
      TypeOr.push({ type: { in: otherTypes } });
    } else TypeOr.push({ type: { not: 'Checkpoint' } });
    AND.push({ OR: TypeOr });
  }

  if (needsReview && currentUser?.isModerator)
    AND.push({ meta: { path: ['needsReview'], equals: true } });

  if (earlyAccess) AND.push({ earlyAccessDeadline: { gte: new Date() } });
  if (tagname) AND.push({ tagsOnModels: { some: { tag: { name: tagname } } } });
  if (!tags?.length) AND.push({ tagsOnModels: { some: { tagId: { in: tags } } } });
  if (username) AND.push({ user: { username } });
  if (!types?.length) AND.push({ type: { in: types } });
  if (rating !== undefined)
    AND.push({
      rank: { AND: [{ ratingAllTime: { gte: rating } }, { ratingAllTime: { lt: rating + 1 } }] },
    });
  if (currentUser) {
    if (favorites)
      AND.push({ engagements: { some: { userId: currentUser.id, type: 'Favorite' } } });
    else if (hidden) AND.push({ engagements: { some: { userId: currentUser.id, type: 'Hide' } } });
  }
  if (!baseModels?.length) AND.push({ modelVersions: { some: { baseModel: { in: baseModels } } } });
  if (period !== MetricTimeframe.AllTime && periodMode !== 'stats') {
    AND.push({
      lastVersionAt: { gte: decreaseDate(new Date(), 1, period.toLowerCase() as ManipulateType) },
    });
  }
  // #endregion

  // #region [ORDER BY]
  let orderBy: Prisma.ModelOrderByWithRelationInput = {
    lastVersionAt: { sort: 'desc', nulls: 'last' },
  };
  if (sort === ModelSort.HighestRated) orderBy = { rank: { [`rating${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostLiked)
    orderBy = { rank: { [`favoriteCount${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostDownloaded)
    orderBy = { rank: { [`downloadCount${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostDiscussed)
    orderBy = { rank: { [`commentCount${period}Rank`]: 'asc' } };
  // #endregion

  const models = await dbRead.model.findMany({
    take,
    where: { AND },
    cursor: cursor ? { id: cursor } : undefined,
    orderBy,
    select,
  });

  return models;
};
