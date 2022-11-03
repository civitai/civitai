import { Prisma } from '@prisma/client';
import { imageDetailsSelect } from '~/server/validators/image/selectors';
import { simpleUserSelect } from '~/server/validators/user/simpleUserSelect';

export const getAllReviewsSelect = Prisma.validator<Prisma.ReviewSelect>()({
  id: true,
  createdAt: true,
  nsfw: true,
  rating: true,
  text: true,
  modelId: true,
  modelVersionId: true,
  modelVersion: {
    select: { id: true, name: true },
  },
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
        select: imageDetailsSelect,
      },
    },
  },
});

const getAllReviews = Prisma.validator<Prisma.ReviewArgs>()({
  select: getAllReviewsSelect,
});

export type ReviewDetails = Prisma.ReviewGetPayload<typeof getAllReviews>;
