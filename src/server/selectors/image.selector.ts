import { ImageIngestionStatus, Prisma } from '@prisma/client';

import { simpleTagSelect } from './tag.selector';

export const imageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  nsfwLevel: true,
  width: true,
  height: true,
  hash: true,
  meta: true,
  userId: true,
  generationProcess: true,
  needsReview: true,
  scannedAt: true,
  ingestion: true,
  postId: true,
  type: true,
  metadata: true,
  createdAt: true,
  tags: {
    select: {
      tag: { select: { ...simpleTagSelect, type: true } },
      automated: true,
      needsReview: true,
    },
    where: { disabled: false },
  },
});

export const profileImageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  name: true,
  url: true,
  nsfwLevel: true,
  hash: true,
  userId: true,
  ingestion: true,
  type: true,
  width: true,
  height: true,
  metadata: true,
});
const profileImage = Prisma.validator<Prisma.ImageDefaultArgs>()({
  select: profileImageSelect,
});
export type ProfileImage = Prisma.ImageGetPayload<typeof profileImage>;

const { name, ...imageSelectWithoutName } = imageSelect;
export { imageSelectWithoutName };

const image = Prisma.validator<Prisma.ImageDefaultArgs>()({ select: imageSelect });
export type ImageModel = Prisma.ImageGetPayload<typeof image>;
export type ImageModelWithIngestion = ImageModel & { ingestion: ImageIngestionStatus };

export const imageResourceHelperSelect = Prisma.validator<Prisma.ImageResourceHelperSelect>()({
  id: true,
  reviewId: true,
  reviewRating: true,
  reviewDetails: true,
  reviewCreatedAt: true,
  name: true,
  hash: true,
  modelVersionId: true,
  modelVersionName: true,
  modelVersionCreatedAt: true,
  modelId: true,
  modelName: true,
  modelDownloadCount: true,
  modelCommentCount: true,
  modelThumbsUpCount: true,
  modelThumbsDownCount: true,
  modelType: true,
});

const imageResourceHelper = Prisma.validator<Prisma.ImageResourceHelperDefaultArgs>()({
  select: imageResourceHelperSelect,
});
export type ImageResourceHelperModel = Prisma.ImageResourceHelperGetPayload<
  typeof imageResourceHelper
>;
