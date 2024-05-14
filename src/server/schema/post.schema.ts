import { MediaType, MetricTimeframe } from '@prisma/client';
import { z } from 'zod';
import { constants } from '~/server/common/constants';
import { PostSort } from '~/server/common/enums';
import { baseQuerySchema, periodModeSchema } from '~/server/schema/base.schema';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { postgresSlugify } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { commaDelimitedStringArray } from '~/utils/zod-helpers';

export type PostsFilterInput = z.infer<typeof postsFilterSchema>;
export const postsFilterSchema = z.object({
  period: z.nativeEnum(MetricTimeframe).default(constants.postFilterDefaults.period),
  periodMode: periodModeSchema,
  sort: z.nativeEnum(PostSort).default(constants.postFilterDefaults.sort),
  draftOnly: z.boolean().optional(),
});

const postInclude = z.enum(['cosmetics']);
export type ImageInclude = z.infer<typeof postInclude>;
export type PostsQueryInput = z.infer<typeof postsQuerySchema>;
export const postsQuerySchema = baseQuerySchema.merge(
  postsFilterSchema.extend({
    limit: z.preprocess((val) => Number(val), z.number().min(0).max(200)).default(100),
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
    followed: z.boolean().optional(),
    clubId: z.number().optional(),
    pending: z.boolean().optional(),
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
  name: z.string(),
});

// consider moving image creation to post service?
export type AddPostImageInput = z.infer<typeof addPostImageSchema>;
export const addPostImageSchema = z.object({
  name: z.string().nullish(),
  url: z.string().url().or(z.string().uuid()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  postId: z.number(),
  modelVersionId: z.number().nullish(),
  index: z.number(),
  mimeType: z.string().optional(),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.keys(value).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
  type: z.nativeEnum(MediaType).default(MediaType.image),
  metadata: z.object({}).passthrough().optional(),
  externalDetailsUrl: z.string().url().optional(),
});

export type UpdatePostImageInput = z.infer<typeof updatePostImageSchema>;
export const updatePostImageSchema = z.object({
  id: z.number(),
  // meta: z.preprocess((value) => {
  //   if (typeof value !== 'object') return null;
  //   if (value && !Object.values(value).filter(isDefined).length) return null;
  //   return value;
  // }, imageMetaSchema.nullish()),
  meta: imageMetaSchema.nullish().transform((val) => {
    if (!val) return val;
    if (!Object.values(val).filter(isDefined).length) return null;
    return val;
  }),
  hideMeta: z.boolean().optional(),
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
  nsfwLevel: z.number().default(sfwBrowsingLevelsFlag),
});

export type PostEditQuerySchema = z.input<typeof postEditQuerySchema>;
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
});
