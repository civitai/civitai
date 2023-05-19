import { BrowsingMode, ImageSort } from './../common/enums';
import {
  ImageGenerationProcess,
  MetricTimeframe,
  NsfwLevel,
  ReviewReactions,
} from '@prisma/client';
import { z } from 'zod';
import { constants } from '~/server/common/constants';
import { usernameSchema } from '~/server/schema/user.schema';
import { periodModeSchema } from '~/server/schema/base.schema';
import { postgresSlugify } from '~/utils/string-helpers';

const stringToNumber = z.preprocess(
  (value) => (value ? Number(value) : undefined),
  z.number().optional()
);

const undefinedString = z.preprocess((value) => (value ? value : undefined), z.string().optional());

export const imageGenerationSchema = z.object({
  prompt: undefinedString,
  negativePrompt: undefinedString,
  cfgScale: stringToNumber,
  steps: stringToNumber,
  sampler: undefinedString,
  seed: stringToNumber,
});

export const imageMetaSchema = imageGenerationSchema
  .extend({
    hashes: z.record(z.string()),
  })
  .partial()
  .passthrough();

export type FaceDetectionInput = z.infer<typeof faceDetectionSchema>;
export const faceDetectionSchema = z.object({
  age: z.number(),
  emotions: z.array(z.object({ emotion: z.string(), score: z.number() })),
  gender: z.enum(['male', 'female', 'unknown']),
  genderConfidence: z.number().optional().default(0),
  live: z.number(),
  real: z.number(),
});

export type ImageAnalysisInput = z.infer<typeof imageAnalysisSchema>;
export const imageAnalysisSchema = z.object({
  drawing: z.number(),
  hentai: z.number(),
  neutral: z.number(),
  porn: z.number(),
  sexy: z.number(),
  faces: z.array(faceDetectionSchema).optional(),
});

// #region [Image Resource]
export type ImageResourceUpsertInput = z.infer<typeof imageResourceUpsertSchema>;
export const imageResourceUpsertSchema = z.object({
  id: z.number().optional(),
  modelVersionId: z.number().optional(),
  name: z.string().optional(),
  detected: z.boolean().optional(),
});
export const isImageResource = (
  entity: ImageResourceUpsertInput
): entity is Omit<ImageResourceUpsertInput, 'id'> & { id: number } => !!entity.id;
export const isNotImageResource = (
  entity: ImageResourceUpsertInput
): entity is Omit<ImageResourceUpsertInput, 'id'> & { id: undefined } => !entity.id;
// #endregion

export const imageSchema = z.object({
  id: z.number().optional(),
  name: z.string().nullish(),
  url: z
    .string()
    .url()
    .or(z.string().uuid('One of the files did not upload properly, please try again')),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.keys(value).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  nsfw: z.nativeEnum(NsfwLevel).optional(),
  analysis: imageAnalysisSchema.optional(),
  // tags: z.array(tagSchema).optional(),
  needsReview: z.boolean().optional(),
  mimeType: z.string().optional(),
  sizeKB: z.number().optional(),
  postId: z.number().optional(),
  resources: z.array(imageResourceUpsertSchema).optional(),
});

export type ImageUploadProps = z.infer<typeof imageSchema>;
export type ImageMetaProps = z.infer<typeof imageMetaSchema> & Record<string, unknown>;

export const imageUpdateSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  url: z
    .string()
    .url()
    .or(z.string().uuid('One of the files did not upload properly, please try again').optional())
    .optional(),
  nsfw: z.boolean().optional(),
  needsReview: z.boolean().optional(),
});
export type ImageUpdateSchema = z.infer<typeof imageUpdateSchema>;

export const imageModerationSchema = z.object({
  ids: z.number().array(),
  nsfw: z.nativeEnum(NsfwLevel).optional(),
  needsReview: z.boolean().optional(),
  delete: z.boolean().optional(),
});
export type ImageModerationSchema = z.infer<typeof imageModerationSchema>;

export type GetModelVersionImagesSchema = z.infer<typeof getModelVersionImageSchema>;
export const getModelVersionImageSchema = z.object({
  modelVersionId: z.number(),
});

export type GetReviewImagesSchema = z.infer<typeof getReviewImagesSchema>;
export const getReviewImagesSchema = z.object({
  reviewId: z.number(),
});

export type GetGalleryImageInput = z.infer<typeof getGalleryImageSchema>;
export const getGalleryImageSchema = z.object({
  limit: z.number().min(0).max(200).default(constants.galleryFilterDefaults.limit),
  cursor: z.union([z.bigint(), z.number()]).optional(),
  modelId: z.number().optional(),
  reviewId: z.number().optional(),
  modelVersionId: z.number().optional(),
  userId: z.number().optional(),
  infinite: z.boolean().default(true),
  period: z.nativeEnum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
  periodMode: periodModeSchema,
  sort: z.nativeEnum(ImageSort).default(constants.galleryFilterDefaults.sort),
  browsingMode: z.nativeEnum(BrowsingMode).optional(),
  tags: z.array(z.number()).optional(),
  excludedTagIds: z.array(z.number()).optional(),
  excludedUserIds: z.array(z.number()).optional(),
  excludedImageIds: z.array(z.number()).optional(),
  singleImageModel: z.boolean().optional(),
  singleImageAlbum: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  types: z.nativeEnum(ImageGenerationProcess).array().optional(),
  needsReview: z.boolean().optional(),
  tagReview: z.boolean().optional(),
});

export const getImageConnectionsSchema = z.object({
  id: z.number(),
  modelId: z.number().nullish(),
  reviewId: z.number().nullish(),
});
export type GetImageConnectionsSchema = z.infer<typeof getImageConnectionsSchema>;

export type UpdateImageInput = z.infer<typeof updateImageSchema>;
export const updateImageSchema = z.object({
  id: z.number(),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.keys(value).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
  hideMeta: z.boolean().optional(),
  nsfw: z.nativeEnum(NsfwLevel).optional(),
  resources: z.array(imageResourceUpsertSchema).optional(),
});

export type IngestImageInput = z.infer<typeof ingestImageSchema>;
export const ingestImageSchema = z.object({
  id: z.number(),
  url: z.string(),
  name: z.string().optional().nullable(),
  width: z.number().optional().nullable(),
  mimeType: z.string().optional().nullable(),
});

// #region [new schemas]
const imageInclude = z.enum(['tags', 'count', 'cosmetics']);
export type ImageInclude = z.infer<typeof imageInclude>;
export type GetInfiniteImagesInput = z.infer<typeof getInfiniteImagesSchema>;
export const getInfiniteImagesSchema = z
  .object({
    limit: z.number().min(0).max(200).default(100),
    cursor: z.union([z.bigint(), z.number()]).optional(),
    skip: z.number().optional(),
    postId: z.number().optional(),
    modelId: z.number().optional(),
    modelVersionId: z.number().optional(),
    reviewId: z.number().optional(),
    username: usernameSchema.optional(),
    excludedTagIds: z.array(z.number()).optional(),
    excludedUserIds: z.array(z.number()).optional(),
    prioritizedUserIds: z.array(z.number()).optional(),
    excludedImageIds: z.array(z.number()).optional(),
    period: z.nativeEnum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
    periodMode: periodModeSchema,
    sort: z.nativeEnum(ImageSort).default(constants.galleryFilterDefaults.sort),
    tags: z.array(z.number()).optional(),
    generation: z.nativeEnum(ImageGenerationProcess).array().optional(),
    withTags: z.boolean().optional(),
    browsingMode: z.nativeEnum(BrowsingMode).optional(),
    needsReview: z.boolean().optional(),
    tagReview: z.boolean().optional(),
    include: z.array(imageInclude).optional().default(['cosmetics']),
    excludeCrossPosts: z.boolean().optional(),
    reactions: z.array(z.nativeEnum(ReviewReactions)).optional(),
  })
  .transform((value) => {
    if (value.withTags) {
      if (!value.include) value.include = [];
      value.include.push('tags');
    }
    return value;
  });

export type GetImagesByCategoryInput = z.infer<typeof getImagesByCategorySchema>;
export const getImagesByCategorySchema = z.object({
  cursor: z.number().optional(),
  limit: z.number().min(1).max(30).optional(),
  imageLimit: z.number().min(1).max(30).optional(),
  sort: z.nativeEnum(ImageSort).optional(),
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

export type GetImageInput = z.infer<typeof getImageSchema>;
export const getImageSchema = z.object({
  id: z.number(),
  // excludedTagIds: z.array(z.number()).optional(),
  // excludedUserIds: z.array(z.number()).optional(),
  // browsingMode: z.nativeEnum(BrowsingMode).optional(),
});
// #endregion

export type RemoveImageResourceSchema = z.infer<typeof removeImageResourceSchema>;
export const removeImageResourceSchema = z.object({
  imageId: z.number(),
  resourceId: z.number(),
});
