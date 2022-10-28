import { Prisma } from '@prisma/client';
import { simpleUserSelect } from './../user/simpleUserSelect';

export const getAllReviewsSelect = Prisma.validator<Prisma.ReviewSelect>()({
  id: true,
  createdAt: true,
  nsfw: true,
  rating: true,
  text: true,
  modelId: true,
  modelVersionId: true,
  user: {
    select: simpleUserSelect,
  },
  reviewReactions: {
    select: {
      id: true,
      reaction: true,
      user: {
        select: simpleUserSelect,
      },
    },
  },
  imagesOnReviews: {
    select: {
      index: true,
      image: {
        select: {
          id: true,
          url: true,
          hash: true,
          height: true,
          width: true,
        },
      },
    },
  },
});

const getAllReviews = Prisma.validator<Prisma.ReviewArgs>()({
  select: getAllReviewsSelect,
});

export type GetAllReviews = Prisma.ReviewGetPayload<typeof getAllReviews>;
