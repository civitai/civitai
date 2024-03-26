import { Prisma } from '@prisma/client';

export const simpleTagSelect = Prisma.validator<Prisma.TagSelect>()({
  id: true,
  name: true,
  isCategory: true,
});
export type SimpleTag = Prisma.TagGetPayload<typeof simpleTag>;
const simpleTag = Prisma.validator<Prisma.TagArgs>()({ select: simpleTagSelect });

export const imageTagSelect = Prisma.validator<Prisma.TagSelect>()({
  ...simpleTagSelect,
  type: true,
  nsfwLevel: true,
});
export type ImageTag = Prisma.TagGetPayload<typeof imageTag>;
const imageTag = Prisma.validator<Prisma.TagArgs>()({ select: imageTagSelect });

export const modelTagCompositeSelect = Prisma.validator<Prisma.ModelTagSelect>()({
  tagId: true,
  tagName: true,
  tagType: true,
  score: true,
  upVotes: true,
  downVotes: true,
});
export const imageTagCompositeSelect = Prisma.validator<Prisma.ImageTagSelect>()({
  tagId: true,
  tagName: true,
  tagType: true,
  score: true,
  upVotes: true,
  downVotes: true,
  tagNsfw: true,
  tagNsfwLevel: true,
  automated: true,
  needsReview: true,
  concrete: true,
  lastUpvote: true,
  source: true,
});
