import { BrowsingMode, ImageSort } from './../common/enums';
import { ImageGenerationProcess, MetricTimeframe } from '@prisma/client';
import { z } from 'zod';
import { constants } from '~/server/common/constants';
import { tagSchema } from '~/server/schema/tag.schema';

const stringToNumber = z.preprocess((value) => Number(value), z.number());

export const imageMetaSchema = z
  .object({
    prompt: z.string(),
    negativePrompt: z.string(),
    cfgScale: stringToNumber,
    steps: stringToNumber,
    sampler: z.string(),
    seed: stringToNumber,
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
  tag: ImageResourceUpsertInput
): tag is Omit<ImageResourceUpsertInput, 'id'> & { id: number } => !!tag.id;
export const isNotImageResource = (
  tag: ImageResourceUpsertInput
): tag is Omit<ImageResourceUpsertInput, 'id'> & { id: undefined } => !tag.id;
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
  nsfw: z.boolean().optional(),
  analysis: imageAnalysisSchema.optional(),
  tags: z.array(tagSchema).optional(),
  needsReview: z.boolean().optional(),
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
  cursor: z.number().optional(),
  modelId: z.number().optional(),
  reviewId: z.number().optional(),
  modelVersionId: z.number().optional(),
  userId: z.number().optional(),
  infinite: z.boolean().default(true),
  period: z.nativeEnum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
  sort: z.nativeEnum(ImageSort).default(constants.galleryFilterDefaults.sort),
  browsingMode: z.nativeEnum(BrowsingMode).optional(),
  tags: z.array(z.number()).optional(),
  excludedTagIds: z.array(z.number()).optional(),
  excludedUserIds: z.array(z.number()).optional(),
  singleImageModel: z.boolean().optional(),
  singleImageAlbum: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  types: z.nativeEnum(ImageGenerationProcess).array().optional(),
  needsReview: z.boolean().optional(),
});

export const getImageConnectionsSchema = z.object({
  id: z.number(),
  modelId: z.number().nullish(),
  reviewId: z.number().nullish(),
});
export type GetImageConnectionsSchema = z.infer<typeof getImageConnectionsSchema>;

export type CreateImageInput = z.infer<typeof createImageSchema>;
export const createImageSchema = z.object({
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
  nsfw: z.boolean().optional(),
  resources: z.array(z.string()).optional(),
  postId: z.number().optional(),
  index: z.number(),
});

export type UpdateImageInput = z.infer<typeof updateImageSchema>;
export const updateImageSchema = z.object({
  id: z.number(),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.keys(value).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
  hideMeta: z.boolean().optional(),
  nsfw: z.boolean().optional(),
  resources: z.array(imageResourceUpsertSchema).optional(),
});
