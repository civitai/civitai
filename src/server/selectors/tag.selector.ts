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
});
export type ImageTag = Prisma.TagGetPayload<typeof imageTag>;
const imageTag = Prisma.validator<Prisma.TagArgs>()({ select: imageTagSelect });

export const imageTagViewSelect = Prisma.validator<Prisma.ImageTagSelect>()({
  imageId: true,
  tagId: true,
  tagName: true,
  tagType: true,
  automated: true,
  confidence: true,
  score: true,
  upVotes: true,
  downVotes: true,
});
export type ImageTagView = Prisma.ImageTagGetPayload<typeof imageTagView>;
const imageTagView = Prisma.validator<Prisma.ImageTagArgs>()({ select: imageTagViewSelect });
