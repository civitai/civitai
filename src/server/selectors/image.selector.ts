import { Prisma } from '@prisma/client';
import type { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { Availability } from '~/shared/utils/prisma/enums';

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
  blockedFor: true,
  postId: true,
  type: true,
  metadata: true,
  createdAt: true,
  hideMeta: true,
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
  imageId: true,
  reviewId: true,
  reviewRating: true,
  reviewDetails: true,
  reviewCreatedAt: true,
  name: true,
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
  modelVersionBaseModel: true,
  detected: true,
});

const imageResourceHelper = Prisma.validator<Prisma.ImageResourceHelperDefaultArgs>()({
  select: imageResourceHelperSelect,
});
export type ImageResourceHelperModel = Prisma.ImageResourceHelperGetPayload<
  typeof imageResourceHelper
>;

const reviewedImageWhere = { needsReview: null, tosViolation: false } as const;

const publishedPostWhere = (): Prisma.PostWhereInput => ({ publishedAt: { lte: new Date() } });

export const publishedImageWhere = (): Prisma.ImageWhereInput => ({
  ...reviewedImageWhere,
  post: publishedPostWhere(),
});

/**
 * `publishedImageWhere`, and the post is not Private: the Prisma form of the App Store's
 * `IMAGE_POST_PUBLIC_SQL` (`app-sub-listing-store.service.ts`), which a SQL fragment cannot share
 * code with. Not identical at one instant: this keeps `publishedAt <= now`, the store's fragment
 * `publishedAt < now()`, so a post published at exactly the instant of this query is listed here
 * and would be refused by a store check run at that same instant (any later check accepts it).
 */
export const publicPostImageWhere = (): Prisma.ImageWhereInput => ({
  ...reviewedImageWhere,
  post: { ...publishedPostWhere(), availability: { not: Availability.Private } },
});

/** An entered image's post may be scheduled for its crucible's end; only unpublishing takes it out. */
export const enteredImageWhere = (): Prisma.ImageWhereInput => ({
  ...reviewedImageWhere,
  post: { publishedAt: { not: null } },
});

/** Unpublished media, held to the same review gates as published media. */
export const draftImageWhere = (post: Prisma.PostWhereInput): Prisma.ImageWhereInput => ({
  ...reviewedImageWhere,
  post: { ...post, publishedAt: null },
});

/**
 * Marks a post the crucible entry modal created, so its unentered media stays pickable later and
 * `revealCrucibleEntryPosts` can find an entered one's scheduled post.
 */
export const CRUCIBLE_ENTRY_DRAFT_METADATA_KEY = 'crucibleEntryDraft';

/** One relation filter rather than an OR of two, so the planner can still semi-join on Post. */
export const publishedOrEntryDraftImageWhere = (): Prisma.ImageWhereInput => ({
  ...reviewedImageWhere,
  post: {
    OR: [
      publishedPostWhere(),
      {
        publishedAt: null,
        metadata: { path: [CRUCIBLE_ENTRY_DRAFT_METADATA_KEY], equals: true },
      },
    ],
  },
});
