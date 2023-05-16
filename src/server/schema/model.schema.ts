import {
  ModelType,
  ModelStatus,
  MetricTimeframe,
  CommercialUse,
  CheckpointType,
  ModelModifier,
  AssociationType,
} from '@prisma/client';
import { z } from 'zod';
import { constants } from '~/server/common/constants';

import { BrowsingMode, ModelSort } from '~/server/common/enums';
import { UnpublishReason, unpublishReasons } from '~/server/common/moderation-helpers';
import { getByIdSchema, paginationSchema, periodModeSchema } from '~/server/schema/base.schema';
import { modelVersionUpsertSchema } from '~/server/schema/model-version.schema';
import { tagSchema } from '~/server/schema/tag.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { postgresSlugify } from '~/utils/string-helpers';

const licensingSchema = z.object({
  allowNoCredit: z.boolean().optional(),
  allowCommercialUse: z.nativeEnum(CommercialUse).optional(),
  allowDerivatives: z.boolean().optional(),
  allowDifferentLicense: z.boolean().optional(),
});

export type UserPreferencesForModelsInput = z.infer<typeof userPreferencesForModelsSchema>;
export const userPreferencesForModelsSchema = z.object({
  excludedIds: z.array(z.number()).optional(),
  excludedUserIds: z.array(z.number()).optional(),
  excludedImageTagIds: z.array(z.number()).optional(),
  excludedTagIds: z.array(z.number()).optional(),
  excludedImageIds: z.array(z.number()).optional(),
});

export const getAllModelsSchema = licensingSchema.merge(userPreferencesForModelsSchema).extend({
  limit: z.preprocess((val) => Number(val), z.number().min(0).max(100)).optional(),
  page: z.preprocess((val) => Number(val), z.number().min(1)).optional(),
  cursor: z.preprocess((val) => Number(val), z.number()).optional(),
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
  browsingMode: z.nativeEnum(BrowsingMode).optional(),
  sort: z.nativeEnum(ModelSort).default(constants.modelFilterDefaults.sort),
  period: z.nativeEnum(MetricTimeframe).default(constants.modelFilterDefaults.period),
  periodMode: periodModeSchema,
  rating: z
    .preprocess((val) => Number(val), z.number())
    .transform((val) => Math.floor(val))
    .optional(),
  favorites: z.preprocess(
    (val) => val === true || val === 'true',
    z.boolean().optional().default(false)
  ),
  hidden: z.preprocess(
    (val) => val === true || val === 'true',
    z.boolean().optional().default(false)
  ),
  needsReview: z.boolean().optional(),
  earlyAccess: z.boolean().optional(),
  ids: z.number().array().optional(),
});

export type GetAllModelsInput = z.input<typeof getAllModelsSchema>;
export type GetAllModelsOutput = z.infer<typeof getAllModelsSchema>;

export type ModelInput = z.infer<typeof modelSchema>;
export const modelSchema = licensingSchema.extend({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: getSanitizedStringSchema().nullish(),
  type: z.nativeEnum(ModelType),
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

export type ModelUpsertInput = z.infer<typeof modelUpsertSchema>;
export const modelUpsertSchema = licensingSchema.extend({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: getSanitizedStringSchema().nullish(),
  type: z.nativeEnum(ModelType),
  status: z.nativeEnum(ModelStatus),
  checkpointType: z.nativeEnum(CheckpointType).nullish(),
  tagsOnModels: z.array(tagSchema).nullish(),
  nsfw: z.boolean().optional(),
  poi: z.boolean().optional(),
  locked: z.boolean().optional(),
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

export type GetModelsByCategoryInput = z.infer<typeof getModelsByCategorySchema>;
export const getModelsByCategorySchema = z.object({
  limit: z.number().min(1).max(30).optional(),
  modelLimit: z.number().min(1).max(30).optional(),
  cursor: z.preprocess((val) => Number(val), z.number()).optional(),
  tag: z.string().optional(),
  tagname: z.string().optional(),
  types: z
    .union([z.nativeEnum(ModelType), z.nativeEnum(ModelType).array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel]))
    .optional(),
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
  browsingMode: z.nativeEnum(BrowsingMode).optional(),
  sort: z.nativeEnum(ModelSort).default(constants.modelFilterDefaults.sort),
  period: z.nativeEnum(MetricTimeframe).default(constants.modelFilterDefaults.period),
  periodMode: periodModeSchema,
  rating: z
    .preprocess((val) => Number(val), z.number())
    .transform((val) => Math.floor(val))
    .optional(),
  favorites: z.preprocess(
    (val) => val === true || val === 'true',
    z.boolean().optional().default(false)
  ),
  hidden: z.preprocess(
    (val) => val === true || val === 'true',
    z.boolean().optional().default(false)
  ),
  excludedIds: z.array(z.number()).optional(),
  excludedUserIds: z.array(z.number()).optional(),
  excludedImageTagIds: z.array(z.number()).optional(),
  excludedTagIds: z.array(z.number()).optional(),
  excludedImageIds: z.array(z.number()).optional(),
  earlyAccess: z.boolean().optional(),
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
export type FindModelsToAssociateSchema = z.infer<typeof findModelsToAssociateSchema>;
export const findModelsToAssociateSchema = z.object({
  query: z.string(),
  limit: z.number().default(5),
});

export type GetAssociatedModelsInput = z.infer<typeof getAssociatedModelsSchema>;
export const getAssociatedModelsSchema = z.object({
  fromId: z.number(),
  type: z.nativeEnum(AssociationType),
});

export type SetAssociatedModelsInput = z.infer<typeof setAssociatedModelsSchema>;
export const setAssociatedModelsSchema = z.object({
  fromId: z.number(),
  type: z.nativeEnum(AssociationType),
  associatedIds: z.number().array(),
});
// #endregion
