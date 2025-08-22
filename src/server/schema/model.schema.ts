import dayjs from '~/shared/utils/dayjs';

import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';
import type { UnpublishReason } from '~/server/common/moderation-helpers';
import { unpublishReasons } from '~/server/common/moderation-helpers';
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
import {
  AssociationType,
  Availability,
  CheckpointType,
  CollectionItemStatus,
  CommercialUse,
  MetricTimeframe,
  ModelModifier,
  ModelStatus,
  ModelType,
  ModelUploadType,
} from '~/shared/utils/prisma/enums';
import { postgresSlugify } from '~/utils/string-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { baseModels } from '~/shared/constants/base-model.constants';

const licensingSchema = z.object({
  allowNoCredit: z.boolean().optional(),
  allowCommercialUse: z.enum(CommercialUse).array().optional(),
  allowDerivatives: z.boolean().optional(),
  allowDifferentLicense: z.boolean().optional(),
});

export type GetModelByIdSchema = z.infer<typeof getModelByIdSchema>;
export const getModelByIdSchema = z.object({
  id: z.number(),
  excludeTrainingData: z.boolean().optional(),
});

export const getAllModelsSchema = z.object({
  ...baseQuerySchema.shape,
  ...licensingSchema.shape,
  ...userPreferencesSchema.shape,

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
    .union([z.enum(ModelType), z.enum(ModelType).array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel]))
    .optional(),
  // TODO [bw]: do we need uploadType in here?
  status: z
    .union([z.enum(ModelStatus), z.enum(ModelStatus).array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel]))
    .optional(),
  checkpointType: z.enum(CheckpointType).optional(),
  baseModels: z
    .union([z.enum(baseModels), z.enum(baseModels).array()])
    .transform((rel) => {
      if (!rel) return undefined;
      return Array.isArray(rel) ? rel : [rel];
    })
    .optional(),
  sort: z.enum(ModelSort).default(constants.modelFilterDefaults.sort),
  period: z.enum(MetricTimeframe).default(constants.modelFilterDefaults.period),
  periodMode: periodModeSchema,
  rating: z
    .preprocess((val) => Number(val), z.number())
    .transform((val) => Math.floor(val))
    .optional(),
  favorites: z.coerce.boolean().optional().default(false),
  hidden: z.coerce.boolean().optional().default(false),
  needsReview: z.coerce.boolean().optional(),
  earlyAccess: z.coerce.boolean().optional(),
  ids: commaDelimitedNumberArray().optional(),
  modelVersionIds: commaDelimitedNumberArray().optional(),
  supportsGeneration: z.coerce.boolean().optional(),
  fromPlatform: z.coerce.boolean().optional(),
  followed: z.coerce.boolean().optional(),
  archived: z.coerce.boolean().optional(),
  collectionId: z.number().optional(),
  collectionItemStatus: z.array(z.enum(CollectionItemStatus)).optional(),
  fileFormats: z.enum(constants.modelFileFormats).array().optional(),
  clubId: z.number().optional(),
  pending: z.boolean().optional(),
  collectionTagId: z.number().optional(),
  availability: z.enum(Availability).optional(),
  disablePoi: z.boolean().optional(),
  disableMinor: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  // Mod only:
  poiOnly: z.boolean().optional(),
  minorOnly: z.boolean().optional(),
});

export type GetAllModelsInput = z.input<typeof getAllModelsSchema>;
export type GetAllModelsOutput = z.infer<typeof getAllModelsSchema>;

export type ModelInput = z.infer<typeof modelSchema>;
export const modelSchema = licensingSchema.extend({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: getSanitizedStringSchema().nullish(),
  type: z.enum(ModelType),
  uploadType: z.enum(ModelUploadType),
  status: z.enum(ModelStatus),
  checkpointType: z.enum(CheckpointType).nullish(),
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
  modelId: z.coerce.number(),
  modelVersionId: z.coerce.number().optional(),
  type: z.enum(constants.modelFileTypes).optional(),
  format: z.enum(constants.modelFileFormats).optional(),
});
export type GetDownloadSchema = z.infer<typeof getDownloadSchema>;

export type ModelGallerySettingsSchema = {
  users?: number[] | undefined;
  tags?: number[] | undefined;
  images?: number[] | undefined;
  level?: number | undefined;
  hiddenImages?: Record<string, number[]> | undefined;
  pinnedPosts?: Record<string, number[]> | undefined;
};

export type ModelGallerySettingsInput = z.infer<typeof modelGallerySettingsInput>;
export const modelGallerySettingsInput = z.object({
  hiddenUsers: z.object({ id: z.number(), username: z.string().nullable() }).array(),
  hiddenTags: z.object({ id: z.number(), name: z.string() }).array(),
  hiddenImages: z.record(z.string(), z.number().array()).optional(),
  level: z.number().optional(),
  pinnedPosts: z
    .record(z.string(), z.number().array().max(constants.modelGallery.maxPinnedPosts))
    .optional(),
});

export type ModelUpsertInput = z.infer<typeof modelUpsertSchema>;
export const modelUpsertSchema = licensingSchema.extend({
  id: z.coerce.number().optional(),
  name: z.string().trim().min(1, 'Name cannot be empty.'),
  description: getSanitizedStringSchema().nullish(),
  type: z.enum(ModelType),
  uploadType: z.enum(ModelUploadType),
  status: z.enum(ModelStatus),
  checkpointType: z.enum(CheckpointType).nullish(),
  tagsOnModels: z.array(tagSchema).nullish(),
  poi: z.boolean().optional(),
  locked: z.boolean().optional(),
  templateId: z.coerce.number().optional(),
  bountyId: z.coerce.number().optional(),
  nsfw: z.boolean().optional(),
  lockedProperties: z.string().array().optional(),
  minor: z.boolean().default(false).optional(),
  sfwOnly: z.boolean().default(false).optional(),
  meta: z
    .looseObject({
      showcaseCollectionId: z.coerce.number().nullish(),
      commentsLocked: z.boolean().default(false),
    })
    .transform((val) => val as ModelMeta | null)
    .nullish(),
  availability: z.enum(Availability).optional(),
});

export type UpdateGallerySettingsInput = z.infer<typeof updateGallerySettingsSchema>;
export const updateGallerySettingsSchema = z.object({
  id: z.number(),
  gallerySettings: modelGallerySettingsInput.nullable(),
});

export type CopyGallerySettingsInput = z.infer<typeof copyGallerySettingsSchema>;
export const copyGallerySettingsSchema = z.object({ id: z.number() });

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
  declinedReason: string;
  declinedAt: string;
  showcaseCollectionId: number;
  cannotPromote: boolean;
  commentsLocked: boolean;
}>;

export type ChangeModelModifierSchema = z.infer<typeof changeModelModifierSchema>;
export const changeModelModifierSchema = z.object({
  id: z.number(),
  mode: z.enum(ModelModifier).nullable(),
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
  type: z.enum(AssociationType),
});

export type SetAssociatedResourcesInput = z.infer<typeof setAssociatedResourcesSchema>;
export const setAssociatedResourcesSchema = z.object({
  fromId: z.number(),
  type: z.enum(AssociationType),
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
  type: z.enum(ModelType),
  checkpointType: z.enum(CheckpointType).optional(),
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
  versionId: z.number(),
});

export type SetModelCollectionShowcaseInput = z.infer<typeof setModelCollectionShowcaseSchema>;
export const setModelCollectionShowcaseSchema = z.object({
  id: z.number(),
  collectionId: z.number().nullable(),
});

export type MigrateResourceToCollectionInput = z.infer<typeof migrateResourceToCollectionSchema>;
export const migrateResourceToCollectionSchema = z.object({
  id: z.coerce.number(),
  collectionName: z.string().optional(),
});

export type IngestModelInput = z.input<typeof ingestModelSchema>;
export const ingestModelSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.coerce.string(),
  poi: z.coerce.boolean(),
  nsfw: z.coerce.boolean(),
  minor: z.coerce.boolean(),
  sfwOnly: z.coerce.boolean(),
});

export type LimitOnly = z.input<typeof limitOnly>;
export const limitOnly = z.object({
  take: z.number().optional(),
});

export type PrivateModelFromTrainingInput = z.infer<typeof privateModelFromTrainingSchema>;
export const privateModelFromTrainingSchema = modelUpsertSchema.extend({
  id: z.number(), // Model should already be created before hand.
  modelVersionIds: z.array(z.number()).optional(),
});

export type PublishPrivateModelInput = z.infer<typeof publishPrivateModelSchema>;
export const publishPrivateModelSchema = z.object({
  modelId: z.number(),
  publishVersions: z.boolean(),
});
