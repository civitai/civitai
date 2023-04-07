import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const resourceReviewSelect = Prisma.validator<Prisma.ResourceReviewSelect>()({
  id: true,
  modelId: true,
  modelVersion: {
    select: {
      id: true,
      name: true,
    },
  },
  rating: true,
  details: true,
  user: { select: userWithCosmeticsSelect },
  createdAt: true,
  helper: {
    select: {
      imageCount: true,
    },
  },
  thread: {
    select: {
      _count: { select: { comments: true } },
    },
  },
});

const resourceReview = Prisma.validator<Prisma.ResourceReviewArgs>()({
  select: resourceReviewSelect,
});
export type ResourceReviewModel = Prisma.ResourceReviewGetPayload<typeof resourceReview>;
