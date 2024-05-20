import {
  AssociationType,
  CheckpointType,
  CollectionItemStatus,
  CommercialUse,
  MetricTimeframe,
  ModelModifier,
  ModelStatus,
  ModelType,
  ModelUploadType,
} from '@prisma/client';
import dayjs from 'dayjs';
import { z } from 'zod';
import { constants } from '~/server/common/constants';
import CustomParseFormat from 'dayjs/plugin/customParseFormat';
dayjs.extend(CustomParseFormat);

import { ModelSort } from '~/server/common/enums';
import { UnpublishReason, unpublishReasons } from '~/server/common/moderation-helpers';
import {
  baseQuerySchema,
  getByIdSchema,
  infiniteQuerySchema,
  paginationSchema,
  periodModeSchema,
  userPreferencesSchema,
} from '~/server/schema/base.schema';
import { modelVersionUpsertSchema } from '~/server/schema/model-version.schema';
import { tagSchema } from '~/server/schema/tag.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { postgresSlugify } from '~/utils/string-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const licensingSchema = z.object({
  allowNoCredit: z.boolean().optional(),
  allowCommercialUse: z.nativeEnum(CommercialUse).array().optional(),
  allowDerivatives: z.boolean().optional(),
  allowDifferentLicense: z.boolean().optional(),
});

export const getAllModelsSchema = baseQuerySchema
  .merge(licensingSchema)
  .merge(userPreferencesSchema)
  .extend({
    limit: z.preprocess((val) => Number(val), z.number().min(0).max(100)).optional(),
    page: z.preprocess((val) => Number(val), z.number().min(1)).optional(),
    cursor: z
      .union([z.bigint(), z.number(), z.string(), z.date()])
      .transform((val) =>
        typeof val === 'string' && dayjs(val, 'YYYY-MM-DDTHH:mm:ss.SSS[Z]', true).isValid()
          ? new Date(val)
          : val
      )
      .optional(),
    query: z.string().optional(),
    tag: z.string().optional(),
    tagname: z.string().optional(),
    user: z.string().optional(),
    username: z
      .string()
      .transform((data) => postgresSlugify(data))
      .optional(),
    types: z
      .union([z.nativeEnum(ModelType), z.nativeEnum(ModelType).array()])
      .optional()
      .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel]))
      .optional(),
    // TODO [bw]: do we need uploadType in here?
    status: z
      .union([z.nativeEnum(ModelStatus), z.nativeEnum(ModelStatus).array()])
      .optional()
      .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel]))
      .optional(),
    checkpointType: z.nativeEnum(CheckpointType).optional(),
    baseModels: z
      .union([z.enum(constants.baseModels), z.enum(constants.baseModels).array()])
      .optional()
      .transform((rel) => {
        if (!rel) return undefined;
        return Array.isArray(rel) ? rel : [rel];
      }),
    sort: z.nativeEnum(ModelSort).default(constants.modelFilterDefaults.sort),
    period: z.nativeEnum(MetricTimeframe).default(constants.modelFilterDefaults.period),
    periodMode: periodModeSchema,
    rating: z
      .preprocess((val) => Number(val), z.number())
      .transform((val) => Math.floor(val))
      .optional(),
    favorites: z.coerce.boolean().optional().default(false),
    hidden: z.coerce.boolean().optional().default(false),
    needsReview: z.coerce.boolean().optional(),
    earlyAccess: z.coerce.boolean().optional(),
    ids: commaDelimitedNumberArray({ message: 'ids should be a number array' }).optional(),
    modelVersionIds: commaDelimitedNumberArray({
      message: 'modelVersionIds should be a number array',
    }).optional(),
    supportsGeneration: z.coerce.boolean().optional(),
    fromPlatform: z.coerce.boolean().optional(),
    followed: z.coerce.boolean().optional(),
    archived: z.coerce.boolean().optional(),
    collectionId: z.number().optional(),
    collectionItemStatus: z.array(z.nativeEnum(CollectionItemStatus)).optional(),
    fileFormats: z.enum(constants.modelFileFormats).array().optional(),
    clubId: z.number().optional(),
    pending: z.boolean().optional(),
  });

export type GetAllModelsInput = z.input<typeof getAllModelsSchema>;
export type GetAllModelsOutput = z.infer<typeof getAllModelsSchema>;

export type ModelInput = z.infer<typeof modelSchema>;
export const modelSchema = licensingSchema.extend({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: getSanitizedStringSchema().nullish(),
  type: z.nativeEnum(ModelType),
  uploadType: z.nativeEnum(ModelUploadType),
  status: z.nativeEnum(ModelStatus),
  checkpointType: z.nativeEnum(CheckpointType).nullish(),
  tagsOnModels: z.array(tagSchema).nullish(),
  nsfw: z.boolean().optional(),
  poi: z.boolean().optional(),
  locked: z.boolean().optional(),
  modelVersions: z
    .array(modelVersionUpsertSchema)
    .min(1, 'At least one model version is required.'),
  // mergePermissions: licensingSchema.array().optional(),
});

export type MergePermissionInput = z.infer<typeof mergePermissionInput>;
export const mergePermissionInput = licensingSchema.extend({
  modelId: z.number(),
  permissionDate: z.date().default(new Date()),
});

export const deleteModelSchema = getByIdSchema.extend({ permanently: z.boolean().optional() });
export type DeleteModelSchema = z.infer<typeof deleteModelSchema>;

export const getDownloadSchema = z.object({
  modelId: z.preprocess((val) => Number(val), z.number()),
  modelVersionId: z.preprocess((val) => Number(val), z.number()).optional(),
  type: z.enum(constants.modelFileTypes).optional(),
  format: z.enum(constants.modelFileFormats).optional(),
});
export type GetDownloadSchema = z.infer<typeof getDownloadSchema>;

export type ModelGallerySettingsSchema = z.infer<typeof modelGallerySettingsSchema>;
export const modelGallerySettingsSchema = z.object({
  users: z.number().array().optional(),
  tags: z.number().array().optional(),
  images: z.number().array().optional(),
  level: z.number().optional(),
  pinnedPosts: z
    .record(z.string(), z.number().array().max(constants.modelGallery.maxPinnedPosts))
    .optional(),
});

export type ModelGallerySettingsInput = z.infer<typeof modelGallerySettingsInput>;
export const modelGallerySettingsInput = z.object({
  hiddenUsers: z.object({ id: z.number(), username: z.string().nullable() }).array(),
  hiddenTags: z.object({ id: z.number(), name: z.string() }).array(),
  hiddenImages: z.number().array(),
  level: z.number().optional(),
  pinnedPosts: z
    .record(z.string(), z.number().array().max(constants.modelGallery.maxPinnedPosts))
    .optional(),
});

export type ModelUpsertInput = z.infer<typeof modelUpsertSchema>;
export const modelUpsertSchema = licensingSchema.extend({
  id: z.number().optional(),
  name: z.string().trim().min(1, 'Name cannot be empty.'),
  description: getSanitizedStringSchema().nullish(),
  type: z.nativeEnum(ModelType),
  uploadType: z.nativeEnum(ModelUploadType),
  status: z.nativeEnum(ModelStatus),
  checkpointType: z.nativeEnum(CheckpointType).nullish(),
  tagsOnModels: z.array(tagSchema).nullish(),
  poi: z.boolean().optional(),
  locked: z.boolean().optional(),
  templateId: z.number().optional(),
  bountyId: z.number().optional(),
  nsfw: z.boolean().optional(),
  lockedProperties: z.string().array().optional(),
});

export type UpdateGallerySettingsInput = z.infer<typeof updateGallerySettingsSchema>;
export const updateGallerySettingsSchema = z.object({
  id: z.number(),
  gallerySettings: modelGallerySettingsInput.nullable(),
});

export type ReorderModelVersionsSchema = z.infer<typeof reorderModelVersionsSchema>;
export const reorderModelVersionsSchema = z.object({
  id: z.number(),
  modelVersions: z.array(
    z.object({ id: z.number(), name: z.string(), index: z.number().nullable() })
  ),
});

export type PublishModelSchema = z.infer<typeof publishModelSchema>;
export const publishModelSchema = z.object({
  id: z.number(),
  versionIds: z.array(z.number()).optional(),
  publishedAt: z.date().optional(),
});

export type UnpublishModelSchema = z.infer<typeof unpublishModelSchema>;
const UnpublishReasons = Object.keys(unpublishReasons);
export const unpublishModelSchema = z.object({
  id: z.number(),
  reason: z.custom<UnpublishReason>((x) => UnpublishReasons.includes(x as string)).optional(),
  customMessage: z.string().optional(),
});

export type ToggleModelLockInput = z.infer<typeof toggleModelLockSchema>;
export const toggleModelLockSchema = z.object({
  id: z.number(),
  locked: z.boolean(),
});

export type ModelMeta = Partial<{
  unpublishedReason: UnpublishReason;
  customMessage: string;
  needsReview: boolean;
  unpublishedAt: string;
  archivedAt: string;
  archivedBy: number;
  takenDownAt: string;
  takenDownBy: number;
  bountyId: number;
  unpublishedBy: number;
}>;

export type ChangeModelModifierSchema = z.infer<typeof changeModelModifierSchema>;
export const changeModelModifierSchema = z.object({
  id: z.number(),
  mode: z.nativeEnum(ModelModifier).nullable(),
});

export type DeclineReviewSchema = z.infer<typeof declineReviewSchema>;
export const declineReviewSchema = z.object({
  id: z.number(),
  reason: z.string().optional(),
});

export type GetModelsWithCategoriesSchema = z.infer<typeof getModelsWithCategoriesSchema>;
export const getModelsWithCategoriesSchema = paginationSchema.extend({
  userId: z.number().optional(),
});

export type SetModelsCategoryInput = z.infer<typeof setModelsCategorySchema>;
export const setModelsCategorySchema = z.object({
  modelIds: z.array(z.number()),
  categoryId: z.number(),
});

// #region [Associated Models]
export type FindResourcesToAssociateSchema = z.infer<typeof findResourcesToAssociateSchema>;
export const findResourcesToAssociateSchema = z.object({
  query: z.string(),
  limit: z.number().default(5),
});

export type GetAssociatedResourcesInput = z.infer<typeof getAssociatedResourcesSchema>;
export const getAssociatedResourcesSchema = baseQuerySchema.extend({
  fromId: z.number(),
  type: z.nativeEnum(AssociationType),
});

export type SetAssociatedResourcesInput = z.infer<typeof setAssociatedResourcesSchema>;
export const setAssociatedResourcesSchema = z.object({
  fromId: z.number(),
  type: z.nativeEnum(AssociationType),
  associations: z
    .object({
      // Association Id
      id: z.number().optional(),
      // Model | Article Id
      resourceId: z.number(),
      resourceType: z.enum(['model', 'article']),
    })
    .array(),
});
// #endregion

export type GetModelVersionsSchema = z.infer<typeof getModelVersionsSchema>;
export const getModelVersionsSchema = z.object({
  id: z.number(),
  excludeUnpublished: z.boolean().optional(),
});

export type ImageModelDetail = z.infer<typeof imageModelDetailSchema>;
export type CharacterModelDetail = z.infer<typeof characterModelDetailSchema>;
export type TextModelDetail = z.infer<typeof textModelDetailSchema>;
export type AudioModelDetail = z.infer<typeof audioModelDetailSchema>;

export const imageModelDetailSchema = z.object({
  type: z.nativeEnum(ModelType),
  checkpointType: z.nativeEnum(CheckpointType).optional(),
});
export const characterModelDetailSchema = z.object({});
export const textModelDetailSchema = z.object({});
export const audioModelDetailSchema = z.object({});

export type ModelByHashesInput = z.infer<typeof modelByHashesInput>;
export const modelByHashesInput = z.object({
  hashes: z.array(z.string()),
});

export type GetSimpleModelsInfiniteSchema = z.infer<typeof getSimpleModelsInfiniteSchema>;
export const getSimpleModelsInfiniteSchema = infiniteQuerySchema.extend({
  query: z.string().trim().optional(),
  userId: z.number(),
});

export type ToggleCheckpointCoverageInput = z.infer<typeof toggleCheckpointCoverageSchema>;
export const toggleCheckpointCoverageSchema = z.object({
  id: z.number(),
  versionId: z.number().nullish(),
});
