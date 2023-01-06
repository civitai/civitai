import { Prisma } from '@prisma/client';

import { imageSelect } from '~/server/selectors/image.selector';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';

export const reviewDetailSelect = (includeNSFW = true, prioritizeSafeImages = false) =>
  Prisma.validator<Prisma.ReviewSelect>()({
    id: true,
    createdAt: true,
    nsfw: true,
    exclude: true,
    rating: true,
    text: true,
    modelId: true,
    modelVersionId: true,
    modelVersion: {
      select: { name: true },
    },
    user: {
      select: simpleUserSelect,
    },
    imagesOnReviews: {
      orderBy: prioritizeSafeImages
        ? [{ image: { nsfw: 'asc' } }, { index: 'asc' }]
        : [{ index: 'asc' }],
      select: {
        index: true,
        image: {
          select: imageSelect,
        },
      },
      where: includeNSFW ? undefined : { image: { nsfw: false } },
    },
    reactions: {
      select: getReactionsSelect,
    },
  });

export const getAllReviewsSelect = (includeNSFW = true, prioritizeSafeImages = false) =>
  Prisma.validator<Prisma.ReviewSelect>()({
    ...reviewDetailSelect(includeNSFW, prioritizeSafeImages),
    _count: {
      select: {
        comments: true,
      },
    },
  });

export type ReviewDetails = Prisma.ReviewGetPayload<typeof getAllReviews>;
const getAllReviews = Prisma.validator<Prisma.ReviewArgs>()({
  select: getAllReviewsSelect,
});
