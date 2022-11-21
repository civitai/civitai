import { ModelType, ModelStatus, MetricTimeframe, ReportReason } from '@prisma/client';
import { z } from 'zod';
import { ModelSort } from '~/server/common/enums';
import { tagSchema } from '~/server/schema/tag.schema';
import { sanitizedStringSchema } from '~/server/schema/utils.schema';
import { modelVersionUpsertSchema } from '~/server/schema/model-version.schema';
import { isNumber } from '~/utils/type-guards';

export const getAllModelsSchema = z
  .object({
    limit: z.number().min(1).max(200),
    cursor: z.number(),
    page: z.number(),
    query: z.string(),
    tag: z.string(),
    user: z.string(),
    types: z.nativeEnum(ModelType).array(),
    sort: z.nativeEnum(ModelSort),
    period: z.nativeEnum(MetricTimeframe),
    rating: z.preprocess((val) => {
      const value = Number(val);
      return isNumber(value) ? Math.floor(value) : null;
    }, z.number()),
  })
  .partial();

export type GetAllModelsInput = z.infer<typeof getAllModelsSchema>;

export const modelSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  description: sanitizedStringSchema,
  type: z.nativeEnum(ModelType),
  status: z.nativeEnum(ModelStatus),
  tagsOnModels: z.array(tagSchema).nullish(),
  nsfw: z.boolean().optional(),
  modelVersions: z
    .array(modelVersionUpsertSchema)
    .min(1, 'At least one model version is required.'),
});

export const reportModelInputSchema = z.object({
  id: z.number(),
  reason: z.nativeEnum(ReportReason),
});
export type ReportModelInput = z.infer<typeof reportModelInputSchema>;
