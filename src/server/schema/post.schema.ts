import * as z from 'zod';
import { CacheTTL, constants } from '~/server/common/constants';
import { PostSort } from '~/server/common/enums';
import type { RateLimit } from '~/server/middleware.trpc';
import { baseQuerySchema, periodModeSchema } from '~/server/schema/base.schema';
import { isBetweenToday } from '~/utils/date-helpers';
import { imageMetaSchema, imageSchema } from '~/server/schema/image.schema';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { postgresSlugify } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { commaDelimitedStringArray, numericStringArray } from '~/utils/zod-helpers';

// Post creation was historically unthrottled (unlike comments/reactions/article
// creation). The MCP/API "prompt-to-post" flow makes unlimited automated posting
// trivial, so apply sane ceilings here. Moderators and dev/test are skipped by the
// rateLimit() middleware.
//
// NOTE on the middleware: for a given period it keeps the HIGHEST limit among the
// rules whose userReq passes. So a tighter cap for a sub-group can't share a period
// with a looser base rule (the looser one would win). The new-account clamp therefore
// lives on the `hour` period, which no base/established rule uses (mirrors
// articleRateLimits). Daily ceilings tier UP by reputation.
export const postRateLimits: RateLimit[] = [
  // Brand-new accounts (< 24h): tight hourly clamp. Not overridden because no other
  // rule uses the hour period.
  {
    limit: 2,
    period: CacheTTL.hour,
    userReq: (user) => !!user.createdAt && isBetweenToday(user.createdAt),
    errorMessage: 'New accounts are limited to a couple of posts per hour for the first 24 hours.',
  },
  // Base daily ceiling (all users, incl. new + low-reputation).
  {
    limit: 20,
    period: CacheTTL.day,
    errorMessage: "You've reached your daily limit for new posts. Please try again tomorrow.",
  },
  // Established accounts.
  {
    limit: 60,
    period: CacheTTL.day,
    userReq: (user) => (user.meta?.scores?.total ?? 0) >= 1000,
    errorMessage: "You've reached your daily limit for new posts. Please try again tomorrow.",
  },
  // High-reputation accounts.
  {
    limit: 150,
    period: CacheTTL.day,
    userReq: (user) => (user.meta?.scores?.total ?? 0) >= 5000,
    errorMessage: "You've reached your daily limit for new posts. Please try again tomorrow.",
  },
];

export type PostsFilterInput = z.infer<typeof postsFilterSchema>;
export const postsFilterSchema = z.object({
  period: z.enum(MetricTimeframe).default(constants.postFilterDefaults.period),
  periodMode: periodModeSchema,
  sort: z.enum(PostSort).default(constants.postFilterDefaults.sort),
  draftOnly: z.boolean().optional(),
  scheduled: z.coerce.boolean().optional(),
});

const postInclude = z.enum(['cosmetics']);
export type ImageInclude = z.infer<typeof postInclude>;
export type PostsQueryInput = z.infer<typeof postsQuerySchema>;
export const postsQuerySchema = baseQuerySchema.merge(
  postsFilterSchema.extend({
    limit: z.preprocess((val) => Number(val), z.number().min(0).max(200)).default(100),
    cursor: z.union([z.number(), z.string()]).optional(),
    query: z.string().optional(),
    excludedTagIds: z.array(z.number()).optional(),
    excludedUserIds: z.array(z.number()).optional(),
    excludedImageIds: z.array(z.number()).optional(),
    tags: z.number().array().optional(),
    username: z
      .string()
      .transform((data) => postgresSlugify(data))
      .nullish(),
    modelVersionId: z.number().optional(),
    ids: z.array(z.number()).optional(),
    collectionId: z.number().optional(),
    include: z.array(postInclude).default(['cosmetics']).optional(),
    followed: z.boolean().optional(),
    clubId: z.number().optional(),
    pending: z.boolean().optional(),
    disablePoi: z.boolean().optional(),
    disableMinor: z.boolean().optional(),
    // Mod only:
    poiOnly: z.boolean().optional(),
    minorOnly: z.boolean().optional(),
  })
);

export type PostCreateInput = z.infer<typeof postCreateSchema>;
export const postCreateSchema = z.object({
  modelVersionId: z.number().nullish(),
  title: z.string().trim().nullish(),
  detail: z.string().nullish(),
  tag: z.number().nullish(),
  tags: commaDelimitedStringArray().optional(),
  publishedAt: z.date().optional(),
  collectionId: z.number().optional(),
});

export type PostUpdateInput = z.infer<typeof postUpdateSchema>;
export const postUpdateSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  detail: z.string().nullish(),
  publishedAt: z.date().optional(),
  collectionId: z.number().nullish(),
  collectionTagId: z.number().nullish(),
});

// Composite create-with-images input for headless/agent (MCP) use. Each image
// reuses the shared imageSchema shape (without postId — the server fills it in
// after creating the post) and requires an explicit ordering index. The post is
// created, images are attached in order, and the post is optionally published in
// a single server-side round-trip.
export type CreatePostWithImagesInput = z.infer<typeof createPostWithImagesSchema>;
export const createPostWithImagesSchema = z.object({
  title: z.string().trim().nullish(),
  detail: z.string().nullish(),
  modelVersionId: z.number().nullish(),
  tag: z.number().nullish(),
  tags: commaDelimitedStringArray().optional(),
  collectionId: z.number().optional(),
  publish: z.boolean().optional(),
  images: z
    .array(
      // Omit `id` as well: this is a create path, so a caller-supplied Image PK
      // would be forwarded into createImage and fail (or clobber). The server
      // fills postId, and index is required for explicit ordering.
      imageSchema.omit({ postId: true, index: true, id: true }).extend({ index: z.number().min(0) })
    )
    .min(1, 'At least one image must be provided'),
});

export type RemovePostTagInput = z.infer<typeof removePostTagSchema>;
export const removePostTagSchema = z.object({
  tagId: z.number(),
  id: z.number(),
});

export type AddPostTagInput = z.infer<typeof addPostTagSchema>;
export const addPostTagSchema = z.object({
  tagId: z.number().optional(),
  id: z.number(),
  name: z.string().trim().toLowerCase(),
});

// consider moving image creation to post service?
export type AddPostImageInput = z.infer<typeof addPostImageSchema>;
export const addPostImageSchema = z.object({
  name: z.string().nullish(),
  url: z.url().or(z.string().uuid()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  postId: z.number(),
  modelVersionId: z.number().nullish(),
  index: z.number(),
  mimeType: z.string().optional(),
  meta: z
    .preprocess((value) => {
      if (typeof value !== 'object') return null;
      if (value && !Object.keys(value).length) return null;
      return value;
    }, imageMetaSchema.nullish())
    .nullish(),
  type: z.enum(MediaType).default(MediaType.image),
  metadata: z.object({}).passthrough().optional(),
  externalDetailsUrl: z.url().optional(),
});

export type UpdatePostImageInput = z.infer<typeof updatePostImageSchema>;
export const updatePostImageSchema = z.object({
  id: z.number(),
  meta: imageMetaSchema.nullish().transform((val) => {
    if (!val) return val;
    if (!Object.values(val).filter(isDefined).length) return null;
    return val;
  }),
  hideMeta: z.boolean().optional(),
});

export type AddResourceToPostImageInput = z.infer<typeof addResourceToPostImageInput>;
export const addResourceToPostImageInput = z.object({
  id: z.array(z.number()),
  modelVersionId: z.number(),
});

export type RemoveResourceFromPostImageInput = z.infer<typeof removeResourceFromPostImageInput>;
export const removeResourceFromPostImageInput = z.object({
  id: z.number(),
  modelVersionId: z.number(),
});

export type ReorderPostImagesInput = z.infer<typeof reorderPostImagesSchema>;
export const reorderPostImagesSchema = z.object({
  id: z.number(),
  imageIds: z.number().array(),
});

export type GetPostTagsInput = z.infer<typeof getPostTagsSchema>;
export const getPostTagsSchema = z.object({
  query: z.string().optional(),
  limit: z.number().default(10),
  nsfwLevel: z.number().default(sfwBrowsingLevelsFlag),
});

export type PostEditQuerySchema = z.infer<typeof postEditQuerySchema>;
export const postEditQuerySchema = z.object({
  postId: z.coerce.number().optional(),
  modelId: z.coerce.number().optional(),
  modelVersionId: z.coerce.number().nullish(),
  tag: z.coerce.number().optional(),
  video: z.coerce.boolean().optional(),
  returnUrl: z.string().optional(),
  clubId: z.coerce.number().optional(),
  reviewing: z.string().optional(),
  src: z.coerce.string().optional(),
  collections: numericStringArray().optional(),
  collectionId: z.coerce.number().optional(),
  collectionTagId: z.coerce.number().optional(),
});

export type UpdatePostCollectionTagIdInput = z.infer<typeof updatePostCollectionTagIdInput>;
export const updatePostCollectionTagIdInput = z.object({
  id: z.number(),
  collectionTagId: z.number(),
});
