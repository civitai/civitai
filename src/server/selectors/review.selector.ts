import { Prisma } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { imageSelect } from '~/server/selectors/image.selector';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const reviewDetailSelect = Prisma.validator<Prisma.ReviewSelect>()({
  id: true,
  createdAt: true,
  nsfw: true,
  exclude: true,
  rating: true,
  text: true,
  locked: true,
  modelId: true,
  modelVersionId: true,
  tosViolation: true,
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
    orderBy: { index: 'asc' },
    select: {
      index: true,
      image: {
        select: imageSelect,
      },
    },
  },
  reactions: {
    select: getReactionsSelect,
  },
});

export const getAllReviewsSelect = Prisma.validator<Prisma.ReviewSelect>()({
  ...reviewDetailSelect,
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
