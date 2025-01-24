import dayjs from 'dayjs';
import { z } from 'zod';
import { SearchIndexEntityTypes } from '~/components/Search/parsers/base';
import { constants } from '~/server/common/constants';
import { baseQuerySchema, paginationSchema, periodModeSchema } from '~/server/schema/base.schema';
import {
  ImageGenerationProcess,
  MediaType,
  MetricTimeframe,
  ReportStatus,
  ReviewReactions,
} from '~/shared/utils/prisma/enums';
import { zc } from '~/utils/schema-helpers';
import { ImageSort, NsfwLevel } from './../common/enums';

const stringToNumber = z.coerce.number().optional();

const undefinedString = z.preprocess((value) => (value ? value : undefined), z.string().optional());

export type ImageEntityType = (typeof imageEntities)[number];
const imageEntities = ['Bounty', 'BountyEntry', 'User', 'Post', 'Article'] as const;
const imageEntitiesSchema = z.enum(imageEntities);
// export type ImageEntityType = (typeof ImageEntityType)[keyof typeof ImageEntityType];

export type ComfyMetaSchema = z.infer<typeof comfyMetaSchema>;
export const comfyMetaSchema = z
  .object({
    prompt: z.object({}).passthrough(),
    workflow: z
      .object({
        nodes: z.object({}).passthrough().array().optional(),
      })
      .passthrough(),
  })
  .partial();

// TODO do we need mediaUrl in here to confirm?
export const externalMetaSchema = z.object({
  /**
   * Name and/or homepage for your service
   */
  source: z
    .object({
      /**
       * Name of your service
       */
      name: z.string().optional(),
      /**
       * Your service's home URL
       */
      homepage: z.string().url().optional(),
    })
    .optional(),
  /**
   * Key-value object for custom parameters specific to your service.
   * Limited to 10 props
   */
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  // details: z.record(z.string(), z.coerce.string()).optional(),
  /**
   * Link back to the URL used to create the media
   */
  createUrl: z.string().url().optional(),
  /**
   * URL to link back to the source of the media
   */
  referenceUrl: z.string().url().optional(),
});
export type ExternalMetaSchema = z.infer<typeof externalMetaSchema>;

export const baseImageMetaSchema = z.object({
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  cfgScale: z.coerce.number().optional(),
  steps: z.coerce.number().optional(),
  sampler: z.string().optional(),
  seed: z.coerce.number().optional(),
  clipSkip: z.coerce.number().optional(),
});

export const imageGenerationSchema = z.object({
  prompt: undefinedString,
  negativePrompt: undefinedString,
  cfgScale: stringToNumber,
  steps: stringToNumber,
  sampler: undefinedString,
  seed: stringToNumber,
  hashes: z.record(z.string()).optional(),
  clipSkip: z.coerce.number().optional(),
  'Clip skip': z.coerce.number().optional(),
  comfy: z.union([z.string().optional(), comfyMetaSchema.optional()]).optional(), // stored as stringified JSON
  external: externalMetaSchema.optional(),
  extra: z
    .object({
      remixOfId: z.number().optional(),
    })
    .optional(),
});

export const imageMetaSchema = imageGenerationSchema.partial().passthrough();
export const imageMetaOutput = imageGenerationSchema
  .extend({
    comfy: z.preprocess((value) => {
      if (typeof value !== 'string') return value;
      try {
        let rVal = value.replace('"workflow": undefined', '"workflow": {}');
        rVal = rVal.replace('[NaN]', '[]');
        return JSON.parse(rVal);
      } catch {
        return {};
      }
    }, comfyMetaSchema.optional()),
    controlNets: z.string().array().optional(),
    software: z.coerce.string().optional(),
    civitaiResources: z.any().optional(),
  })
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

export type ImageSchema = z.infer<typeof imageSchema>;
export const imageSchema = z.object({
  id: z.number().optional(),
  name: z.string().nullish(),
  url: z.string().uuid('One of the files did not upload properly, please try again'),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.keys(value).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  mimeType: z.string().optional(),
  sizeKB: z.number().optional(),
  postId: z.number().nullish(),
  modelVersionId: z.number().nullish(),
  type: z.nativeEnum(MediaType).default(MediaType.image),
  metadata: z.object({}).passthrough().optional(),
  externalDetailsUrl: z.string().url().optional(),
  toolIds: z.number().array().optional(),
  techniqueIds: z.number().array().optional(),
  index: z.number().optional(),
});

export const comfylessImageSchema = imageSchema.extend({
  meta: imageGenerationSchema.omit({ comfy: true }).nullish(),
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
  needsReview: z.string().nullish(),
});
export type ImageUpdateSchema = z.infer<typeof imageUpdateSchema>;

export const imageModerationSchema = z.object({
  ids: z.number().array(),
  needsReview: z.string().nullish(),
  reviewAction: z.enum(['delete', 'removeName', 'mistake']).optional(),
  reviewType: z.enum(['minor', 'poi', 'reported', 'csam', 'blocked', 'tag', 'newUser', 'appeal']),
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

export type UpdateImageInput = z.infer<typeof updateImageSchema>;
export const updateImageSchema = z.object({
  id: z.number(),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.keys(value).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
  hideMeta: z.boolean().optional(),
  resources: z.array(imageResourceUpsertSchema).optional(),
});

export type IngestImageInput = z.infer<typeof ingestImageSchema>;
export const ingestImageSchema = z.object({
  id: z.number(),
  url: z.string(),
  type: z.nativeEnum(MediaType).optional(),
  height: z.coerce.number().nullish(),
  width: z.coerce.number().nullish(),
  prompt: z.string().nullish(),
});

const imageInclude = z.enum([
  'tags',
  'count',
  'cosmetics',
  'report',
  'meta',
  'tagIds',
  'profilePictures',
  'metaSelect',
]);
export type ImageInclude = z.infer<typeof imageInclude>;
export type GetInfiniteImagesInput = z.input<typeof getInfiniteImagesSchema>;
export type GetInfiniteImagesOutput = z.output<typeof getInfiniteImagesSchema>;

// TODO try using ".strict()", fix "authed" as unrecognized key

// faux-extends imagesQueryParamSchema output type
export const getInfiniteImagesSchema = baseQuerySchema
  .extend({
    // - from imagesQueryParamSchema
    baseModels: z.enum(constants.baseModels).array().optional(),
    collectionId: z.number().optional(),
    collectionTagId: z.number().optional(),
    hideAutoResources: z.boolean().optional(),
    hideManualResources: z.boolean().optional(),
    followed: z.boolean().optional(),
    fromPlatform: z.coerce.boolean().optional(),
    hidden: z.boolean().optional(),
    limit: z.number().min(0).max(200).default(constants.galleryFilterDefaults.limit),
    modelId: z.number().optional(),
    modelVersionId: z.number().optional(),
    notPublished: z.coerce.boolean().optional(),
    period: z.nativeEnum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
    periodMode: periodModeSchema,
    postId: z.number().optional(),
    prioritizedUserIds: z.array(z.number()).optional(),
    reactions: z.array(z.nativeEnum(ReviewReactions)).optional(),
    // section: z.enum(imageSections),
    scheduled: z.coerce.boolean().optional(),
    sort: z.nativeEnum(ImageSort).default(constants.galleryFilterDefaults.sort),
    tags: z.array(z.number()).optional(),
    techniques: z.number().array().optional(),
    tools: z.number().array().optional(),
    types: z.array(z.nativeEnum(MediaType)).optional(),
    useIndex: z.boolean().nullish(),
    userId: z.number().optional(),
    username: zc.usernameValidationSchema.optional(),
    // view: z.enum(['categories', 'feed']),
    withMeta: z.boolean().optional(),

    // - additional
    cursor: z
      .union([z.bigint(), z.number(), z.string(), z.date()])
      .transform((val) =>
        typeof val === 'string' && dayjs(val, 'YYYY-MM-DDTHH:mm:ss.SSS[Z]', true).isValid()
          ? new Date(val)
          : val
      )
      .optional(),
    excludedTagIds: z.array(z.number()).optional(),
    excludedUserIds: z.array(z.number()).optional(),
    // excludedImageIds: z.array(z.number()).optional(),
    generation: z.nativeEnum(ImageGenerationProcess).array().optional(),
    ids: z.array(z.number()).optional(),
    imageId: z.number().optional(),
    include: z.array(imageInclude).optional().default(['cosmetics']),
    includeBaseModel: z.boolean().optional(),
    pending: z.boolean().optional(),
    postIds: z.number().array().optional(),
    reviewId: z.number().optional(),
    skip: z.number().optional(),
    withTags: z.boolean().optional(),
    remixOfId: z.number().optional(),
    remixesOnly: z.boolean().optional(),
    nonRemixesOnly: z.boolean().optional(),
  })
  .transform((value) => {
    if (value.withTags) {
      if (!value.include) value.include = [];
      value.include.push('tags');
    }
    if (value.withMeta) {
      if (!value.include) value.include = [];
      value.include.push('meta');
    }
    return value;
  });

export type GetImageInput = z.infer<typeof getImageSchema>;
export const getImageSchema = z.object({
  id: z.number(),
  withoutPost: z.boolean().optional(),
  // excludedTagIds: z.array(z.number()).optional(),
  // excludedUserIds: z.array(z.number()).optional(),
});

export type RemoveImageResourceSchema = z.infer<typeof removeImageResourceSchema>;
export const removeImageResourceSchema = z.object({
  imageId: z.number(),
  resourceId: z.number(),
});

export type GetEntitiesCoverImage = z.infer<typeof getEntitiesCoverImage>;
export const getEntitiesCoverImage = z.object({
  entities: z.array(
    z.object({
      entityType: z.union([z.nativeEnum(SearchIndexEntityTypes), z.enum(['ModelVersion', 'Post'])]),
      entityId: z.number(),
    })
  ),
});

export type ImageReviewQueueInput = z.infer<typeof imageReviewQueueInputSchema>;
export const imageReviewQueueInputSchema = z.object({
  limit: z.number().min(0).max(200).default(100),
  cursor: z.union([z.bigint(), z.number()]).optional(),
  needsReview: z.string().nullish(),
  tagReview: z.boolean().optional(),
  reportReview: z.boolean().optional(),
  tagIds: z.array(z.number()).optional(),
});

export type ScanJobsOutput = z.output<typeof scanJobsSchema>;
export const scanJobsSchema = z
  .object({
    scans: z.record(z.string(), z.number()).default({}),
    retryCount: z.number().optional(),
  })
  .passthrough();
// .catchall(z.string());

export type UpdateImageNsfwLevelOutput = z.output<typeof updateImageNsfwLevelSchema>;
export const updateImageNsfwLevelSchema = z.object({
  id: z.number(),
  nsfwLevel: z.nativeEnum(NsfwLevel),
  status: z.nativeEnum(ReportStatus).optional(),
});

export const getImageRatingRequestsSchema = paginationSchema.extend({
  status: z.nativeEnum(ReportStatus).array().optional(),
});

export type ImageRatingReviewOutput = z.infer<typeof imageRatingReviewInput>;
export const imageRatingReviewInput = z.object({
  limit: z.number(),
  cursor: z.string().optional(),
});

export type ReportCsamImagesInput = z.infer<typeof reportCsamImagesSchema>;
export const reportCsamImagesSchema = z.object({
  imageIds: z.array(z.number()).min(1),
});

// #region [image tools]
const baseImageToolSchema = z.object({
  imageId: z.number(),
  toolId: z.number(),
});
export type AddOrRemoveImageToolsOutput = z.output<typeof addOrRemoveImageToolsSchema>;
export const addOrRemoveImageToolsSchema = z.object({ data: baseImageToolSchema.array() });

export type UpdateImageToolsOutput = z.output<typeof updateImageToolsSchema>;
export const updateImageToolsSchema = z.object({
  data: baseImageToolSchema.extend({ notes: z.string().nullish() }).array(),
});
// #endregion

// #region [image tools]
const baseImageTechniqueSchema = z.object({
  imageId: z.number(),
  techniqueId: z.number(),
});
export type AddOrRemoveImageTechniquesOutput = z.output<typeof addOrRemoveImageTechniquesSchema>;
export const addOrRemoveImageTechniquesSchema = z.object({
  data: baseImageTechniqueSchema.array(),
});

export type UpdateImageTechniqueOutput = z.output<typeof updateImageTechniqueSchema>;
export const updateImageTechniqueSchema = z.object({
  data: baseImageTechniqueSchema.extend({ notes: z.string().nullish() }).array(),
});
// #endregion

export type SetVideoThumbnailInput = z.infer<typeof setVideoThumbnailSchema>;
export const setVideoThumbnailSchema = z.object({
  imageId: z.number(),
  frame: z.number().nullable(),
  customThumbnail: imageSchema.nullish(),
  postId: z.number().optional(),
});

export type UpdateImageMinorInput = z.infer<typeof updateImageMinorSchema>;
export const updateImageMinorSchema = z.object({
  id: z.number(),
  collectionId: z.number(),
  minor: z.boolean(),
});
