import { z } from 'zod';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { postgresSlugify } from '~/utils/string-helpers';
import { constants } from '~/server/common/constants';
import { MediaType, MetricTimeframe, NsfwLevel } from '@prisma/client';
import { BrowsingMode, PostSort } from '~/server/common/enums';
import { isDefined } from '~/utils/type-guards';
import { periodModeSchema } from '~/server/schema/base.schema';

export type PostsFilterInput = z.infer<typeof postsFilterSchema>;
export const postsFilterSchema = z.object({
  browsingMode: z.nativeEnum(BrowsingMode).default(constants.postFilterDefaults.browsingMode),
  period: z.nativeEnum(MetricTimeframe).default(constants.postFilterDefaults.period),
  periodMode: periodModeSchema,
  sort: z.nativeEnum(PostSort).default(constants.postFilterDefaults.sort),
});

const postInclude = z.enum(['cosmetics']);
export type ImageInclude = z.infer<typeof postInclude>;
export type PostsQueryInput = z.infer<typeof postsQuerySchema>;
export const postsQuerySchema = postsFilterSchema.extend({
  limit: z.preprocess((val) => Number(val), z.number().min(0).max(100)).default(50),
  cursor: z.preprocess((val) => Number(val), z.number()).optional(),
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
});

export type PostCreateInput = z.infer<typeof postCreateSchema>;
export const postCreateSchema = z.object({
  modelVersionId: z.number().optional(),
  title: z.string().trim().optional(),
  tag: z.number().optional(),
  publishedAt: z.date().optional(),
  collectionId: z.number().optional(),
});

export type PostUpdateInput = z.infer<typeof postUpdateSchema>;
export const postUpdateSchema = z.object({
  id: z.number(),
  nsfw: z.boolean().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  publishedAt: z.date().optional(),
  collectionId: z.number().nullish(),
});

export type RemovePostTagInput = z.infer<typeof removePostTagSchema>;
export const removePostTagSchema = z.object({
  tagId: z.number(),
  id: z.number(),
});

export type GetPostsByCategoryInput = z.infer<typeof getPostsByCategorySchema>;
export const getPostsByCategorySchema = z.object({
  cursor: z.number().optional(),
  limit: z.number().min(1).max(30).optional(),
  postLimit: z.number().min(1).max(30).optional(),
  sort: z.nativeEnum(PostSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  periodMode: periodModeSchema,
  browsingMode: z.nativeEnum(BrowsingMode).optional(),
  excludedTagIds: z.array(z.number()).optional(),
  excludedUserIds: z.array(z.number()).optional(),
  excludedImageIds: z.array(z.number()).optional(),
  tags: z.number().array().optional(),
  username: z
    .string()
    .transform((data) => postgresSlugify(data))
    .nullish(),
  modelVersionId: z.number().optional(),
  modelId: z.number().optional(),
});

export type AddPostTagInput = z.infer<typeof addPostTagSchema>;
export const addPostTagSchema = z.object({
  tagId: z.number().optional(),
  id: z.number(),
  name: z.string(),
});

// consider moving image creation to post service?
export type AddPostImageInput = z.infer<typeof addPostImageSchema>;
export const addPostImageSchema = z.object({
  // userId: z.number(),
  name: z.string().nullish(),
  url: z.string().url().or(z.string().uuid()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  nsfw: z.nativeEnum(NsfwLevel).optional(),
  postId: z.number(),
  modelVersionId: z.number().optional(),
  index: z.number(),
  mimeType: z.string().optional(),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.keys(value).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
  type: z.nativeEnum(MediaType).default(MediaType.image),
  metadata: z.object({}).passthrough().optional(),
});

export type UpdatePostImageInput = z.infer<typeof updatePostImageSchema>;
export const updatePostImageSchema = z.object({
  id: z.number(),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.values(value).filter(isDefined).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
  hideMeta: z.boolean().optional(),
  nsfw: z.nativeEnum(NsfwLevel).optional(),
  // resources: z.array(imageResourceUpsertSchema),
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
});
