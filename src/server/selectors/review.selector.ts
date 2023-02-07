import { Prisma } from '@prisma/client';

import { imageSelect } from '~/server/selectors/image.selector';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const reviewDetailSelect = (includeNSFW = true) =>
  Prisma.validator<Prisma.ReviewSelect>()({
    id: true,
    createdAt: true,
    nsfw: true,
    exclude: true,
    rating: true,
    text: true,
    locked: true,
    modelId: true,
    modelVersionId: true,
    model: {
      select: { name: true },
    },
    modelVersion: {
      select: { name: true },
    },
    user: {
      select: userWithCosmeticsSelect,
    },
    imagesOnReviews: {
      // orderBy: prioritizeSafeImages
      //   ? [{ image: { nsfw: 'asc' } }, { index: 'asc' }]
      //   : [{ index: 'asc' }],
      orderBy: { index: 'asc' },
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

export const getAllReviewsSelect = (includeNSFW = true) =>
  Prisma.validator<Prisma.ReviewSelect>()({
    ...reviewDetailSelect(includeNSFW),
    _count: {
      select: {
        comments: true,
      },
    },
  });

// export type ReviewDetails = Prisma.ReviewGetPayload<typeof getAllReviews>;
// const getAllReviews = Prisma.validator<Prisma.ReviewArgs>()({
//   select: getAllReviewsSelect,
// });
