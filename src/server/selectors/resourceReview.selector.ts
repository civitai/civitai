import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const resourceReviewSimpleSelect = Prisma.validator<Prisma.ResourceReviewSelect>()({
  id: true,
  modelId: true,
  modelVersionId: true,
  recommended: true,
  details: true,
  createdAt: true,
  exclude: true,
});
const resourceReviewSimple = Prisma.validator<Prisma.ResourceReviewArgs>()({
  select: resourceReviewSimpleSelect,
});
export type ResourceReviewSimpleModel = Prisma.ResourceReviewGetPayload<
  typeof resourceReviewSimple
>;

export const resourceReviewSelect = Prisma.validator<Prisma.ResourceReviewSelect>()({
  ...resourceReviewSimpleSelect,
  modelVersion: {
    select: {
      id: true,
      name: true,
    },
  },
  rating: true,
  user: { select: userWithCosmeticsSelect },
  nsfw: true,
  metadata: true,
  // helper: {
  //   select: {
  //     imageCount: true,
  //   },
  // },
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
