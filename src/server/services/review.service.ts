import { ReviewFilter, ReviewSort } from './../common/enums';
import { Prisma } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetAllReviewsInput } from '~/server/schema/review.schema';

export const getReviews = async <TSelect extends Prisma.ReviewSelect>({
  input: { limit, page, cursor, modelId, modelVersionId, userId, filterBy, sort },
  user,
  select,
}: {
  input: GetAllReviewsInput;
  user?: SessionUser;
  select: TSelect;
}) => {
  const take = limit ?? 10;
  const skip = page ? (page - 1) * take : undefined;
  // const canViewNsfw = user?.showNsfw;
  const canViewNsfw = user?.showNsfw
    ? filterBy?.includes(ReviewFilter.NSFW)
      ? true
      : undefined
    : false;

  return await prisma.review.findMany({
    take,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      modelId,
      modelVersionId,
      userId,
      nsfw: !canViewNsfw ? { equals: false } : undefined,
      imagesOnReviews: filterBy?.includes(ReviewFilter.IncludesImages) ? { some: {} } : undefined,
    },
    orderBy: {
      createdAt:
        sort === ReviewSort.Oldest ? 'asc' : sort === ReviewSort.Newest ? 'desc' : undefined,
    },
    select,
  });
};
