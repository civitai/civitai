import {
  ModelType,
  ModelStatus,
  MetricTimeframe,
  CommercialUse,
  CheckpointType,
  ModelFileFormat,
} from '@prisma/client';
import { z } from 'zod';
import { constants } from '~/server/common/constants';

import { BrowsingMode, ModelSort } from '~/server/common/enums';
import { getByIdSchema } from '~/server/schema/base.schema';
import { modelVersionUpsertSchema } from '~/server/schema/model-version.schema';
import { tagSchema } from '~/server/schema/tag.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { postgresSlugify } from '~/utils/string-helpers';

export const getAllModelsSchema = z.object({
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
  excludedTagIds: z.array(z.number()).optional(),
});

export type GetAllModelsInput = z.input<typeof getAllModelsSchema>;
export type GetAllModelsOutput = z.infer<typeof getAllModelsSchema>;

const licensingSchema = z.object({
  allowNoCredit: z.boolean().optional(),
  allowCommercialUse: z.nativeEnum(CommercialUse).optional(),
  allowDerivatives: z.boolean().optional(),
  allowDifferentLicense: z.boolean().optional(),
});

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
export type ModelInput = z.infer<typeof modelSchema>;

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
  format: z.nativeEnum(ModelFileFormat).optional(),
});
export type GetDownloadSchema = z.infer<typeof getDownloadSchema>;
