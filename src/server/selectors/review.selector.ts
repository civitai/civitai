import { imageSelect } from '~/server/selectors/image.selector';
import { Prisma } from '@prisma/client';
import { simpleUserSelect } from '~/server/selectors/user.selector';

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
  imagesOnReviews: {
    select: {
      index: true,
      image: {
        select: imageSelect,
      },
    },
  },
});

export type ReviewDetails = Prisma.ReviewGetPayload<typeof getAllReviews>;
const getAllReviews = Prisma.validator<Prisma.ReviewArgs>()({
  select: getAllReviewsSelect,
});

export const getReactionsSelect = Prisma.validator<Prisma.ReviewReactionSelect>()({
  id: true,
  reaction: true,
  user: {
    select: simpleUserSelect,
  },
});

export type ReactionDetails = Prisma.ReviewReactionGetPayload<typeof getReactions>;
const getReactions = Prisma.validator<Prisma.ReviewReactionArgs>()({
  select: getReactionsSelect,
});
