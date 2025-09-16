import dayjs from '~/shared/utils/dayjs';
import * as z from 'zod';
import { imageSelectProfileFilterSchema } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { SearchIndexEntityTypes } from '~/components/Search/parsers/base';
import { constants } from '~/server/common/constants';
import {
  baseQuerySchema,
  infiniteQuerySchema,
  paginationSchema,
  periodModeSchema,
} from '~/server/schema/base.schema';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import {
  ImageGenerationProcess,
  MediaType,
  MetricTimeframe,
  ReportStatus,
  ReviewReactions,
} from '~/shared/utils/prisma/enums';
import { zc } from '~/utils/schema-helpers';
import { ImageSort, NsfwLevel } from './../common/enums';
import { baseModelGroups, baseModels } from '~/shared/constants/base-model.constants';
import { usernameSchema } from '~/shared/zod/username.schema';

const stringToNumber = z.coerce.number().optional();

const undefinedString = z
  .preprocess((value) => (value ? value : undefined), z.string().optional())
  .optional();

export type ImageEntityType = (typeof imageEntities)[number];
const imageEntities = ['Bounty', 'BountyEntry', 'User', 'Post', 'Article'] as const;
const imageEntitiesSchema = z.enum(imageEntities);
// export type ImageEntityType = (typeof ImageEntityType)[keyof typeof ImageEntityType];

export type ComfyMetaSchema = z.infer<typeof comfyMetaSchema>;
export const comfyMetaSchema = z
  .object({
    prompt: z.looseObject({}),
    workflow: z.looseObject({
      nodes: z.looseObject({}).array().optional(),
    }),
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
      homepage: z.url().optional(),
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
  createUrl: z.url().optional(),
  /**
   * URL to link back to the source of the media
   */
  referenceUrl: z.url().optional(),
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

export const imageMetadataResourceSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  weight: z.number().optional(),
  hash: z.string().optional(),
});

export const additionalResourceSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  strength: z.number().optional(),
  strengthClip: z.number().optional(),
});

export type CivitaiResource = z.infer<typeof civitaiResourceSchema>;
export const civitaiResourceSchema = z.object({
  type: z.string().optional(),
  weight: z.number().optional(),
  modelVersionId: z.number(),
});

export const imageGenerationSchema = z.object({
  baseModel: z.enum(baseModelGroups).optional(),
  prompt: undefinedString,
  negativePrompt: undefinedString,
  cfgScale: stringToNumber,
  steps: stringToNumber,
  sampler: undefinedString,
  seed: stringToNumber,
  hashes: z.record(z.string(), z.string()).optional(),
  clipSkip: z.coerce.number().optional(),
  'Clip skip': z.coerce.number().optional(),
  comfy: z.union([z.string().optional(), comfyMetaSchema.optional()]).optional(), // stored as stringified JSON
  external: externalMetaSchema.optional(),
  effects: z.record(z.string(), z.any()).optional(),
  engine: z.string().optional(),
  version: z.string().optional(),
  process: z.string().optional(),
  type: z.string().optional(),
  workflow: z.string().optional(),
  resources: imageMetadataResourceSchema.array().optional(),
  additionalResources: additionalResourceSchema.array().optional(),
  civitaiResources: civitaiResourceSchema.array().optional(),
  extra: z
    .object({
      remixOfId: z.number().optional(),
    })
    .optional()
    .catch(undefined),
});

export const imageMetaSchema = z.looseObject({ ...imageGenerationSchema.shape });
export const imageMetaOutput = imageGenerationSchema
  .extend({
    comfy: z
      .preprocess((value) => {
        if (typeof value !== 'string') return value;
        try {
          let rVal = value.replace('"workflow": undefined', '"workflow": {}');
          rVal = rVal.replace('[NaN]', '[]');
          return JSON.parse(rVal);
        } catch {
          return {};
        }
      }, comfyMetaSchema.optional())
      .optional(),
    controlNets: z.string().array().optional(),
    software: z.coerce.string().optional(),
    civitaiResources: civitaiResourceSchema.array().optional(),
    process: z.string().optional(),
    type: z.string().optional(),
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
  meta: z
    .preprocess((value) => {
      if (!value || typeof value !== 'object' || !Object.keys(value).length) {
        return null;
      }
      return value;
    }, imageMetaSchema.nullish())
    .nullish(),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  mimeType: z.string().optional(),
  sizeKB: z.number().optional(),
  postId: z.number().nullish(),
  modelVersionId: z.number().nullish(),
  type: z.enum(MediaType).default(MediaType.image),
  metadata: z.record(z.string(), z.any()).optional(),
  externalDetailsUrl: z.url().optional(),
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
  reviewAction: z.enum(['unblock', 'block']),
});
export type ImageModerationSchema = z.infer<typeof imageModerationSchema>;
export type ImageModerationUnblockSchema = {
  ids: number[];
  moderatorId?: number;
};
export type ImageModerationBlockSchema = {
  ids?: number[];
  userId?: number;
  include?: Array<'user-notification' | 'phash-block'>;
  moderatorId?: number;
};

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
  meta: z
    .preprocess((value) => {
      if (typeof value !== 'object') return null;
      if (value && !Object.keys(value).length) return null;
      return value;
    }, imageMetaSchema.nullish())
    .nullish(),
  hideMeta: z.boolean().optional(),
  resources: z.array(imageResourceUpsertSchema).optional(),
});

export type IngestImageInput = z.infer<typeof ingestImageSchema>;
export const ingestImageSchema = z.object({
  id: z.number(),
  url: z.string(),
  type: z.enum(MediaType).optional(),
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
    baseModels: z.enum(baseModels).array().optional(),
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
    period: z.enum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
    periodMode: periodModeSchema,
    postId: z.number().optional(),
    prioritizedUserIds: z.array(z.number()).optional(),
    reactions: z.array(z.enum(ReviewReactions)).optional(),
    // section: z.enum(imageSections),
    scheduled: z.coerce.boolean().optional(),
    sort: z.enum(ImageSort).default(constants.galleryFilterDefaults.sort),
    tags: z.array(z.number()).optional(),
    techniques: z.number().array().optional(),
    tools: z.number().array().optional(),
    types: z.array(z.enum(MediaType)).optional(),
    useIndex: z.boolean().nullish(),
    userId: z.number().optional(),
    username: usernameSchema.optional(),
    // view: z.enum(['categories', 'feed']),
    withMeta: z.boolean().default(false),
    requiringMeta: z.boolean().optional(),

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
    generation: z.enum(ImageGenerationProcess).array().optional(),
    ids: z.array(z.number()).optional(),
    imageId: z.number().optional(),
    include: z.array(imageInclude).default(['cosmetics']),
    includeBaseModel: z.boolean().optional(),
    pending: z.boolean().optional(),
    postIds: z.number().array().optional(),
    reviewId: z.number().optional(),
    skip: z.number().optional(),
    withTags: z.boolean().optional(),
    remixOfId: z.number().optional(),
    remixesOnly: z.boolean().optional(),
    nonRemixesOnly: z.boolean().optional(),
    disablePoi: z.boolean().optional(),
    disableMinor: z.boolean().optional(),
    // Mod only:
    poiOnly: z.boolean().optional(),
    minorOnly: z.boolean().optional(),
  })
  .transform((value) => {
    if (value.withTags) {
      if (!value.include) value.include = [];
      if (!value.include.includes('tags')) value.include.push('tags');
    }
    if (value.withMeta) {
      if (!value.include) value.include = [];
      if (!value.include.includes('meta')) value.include.push('meta');
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
  modelVersionId: z.number(),
});

export type GetEntitiesCoverImage = z.infer<typeof getEntitiesCoverImage>;
export const getEntitiesCoverImage = z.object({
  entities: z.array(
    z.object({
      entityType: z.union([z.enum(SearchIndexEntityTypes), z.enum(['ModelVersion', 'Post'])]),
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
  excludedTagIds: z.array(z.number()).optional(),
  browsingLevel: z.number().default(allBrowsingLevelsFlag),
});

export type ScanJobsOutput = z.output<typeof scanJobsSchema>;
export const scanJobsSchema = z.looseObject({
  scans: z.record(z.string(), z.number()).default({}),
  retryCount: z.number().optional(),
});
// .catchall(z.string());

export type UpdateImageNsfwLevelOutput = z.output<typeof updateImageNsfwLevelSchema>;
export const updateImageNsfwLevelSchema = z.object({
  id: z.number(),
  nsfwLevel: z.enum(NsfwLevel),
  status: z.enum(ReportStatus).optional(),
});

export const getImageRatingRequestsSchema = paginationSchema.extend({
  status: z.enum(ReportStatus).array().optional(),
});

export type ImageRatingReviewOutput = z.infer<typeof imageRatingReviewInput>;
export const imageRatingReviewInput = z.object({
  limit: z.number(),
  cursor: z.number().optional(),
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

export type UpdateImageAcceptableMinorInput = z.infer<typeof updateImageAcceptableMinorSchema>;
export const updateImageAcceptableMinorSchema = z.object({
  id: z.number(),
  collectionId: z.number(),
  acceptableMinor: z.boolean(),
});

export type ToggleImageFlagInput = z.infer<typeof toggleImageFlagSchema>;
export const toggleImageFlagSchema = z.object({
  id: z.number(),
  flag: z.enum(['minor', 'poi']),
});

export type GetMyImagesInput = z.infer<typeof getMyImagesInput>;
export const getMyImagesInput = infiniteQuerySchema.merge(imageSelectProfileFilterSchema);
