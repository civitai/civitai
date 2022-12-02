import { ModelType, ModelStatus, MetricTimeframe } from '@prisma/client';
import { z } from 'zod';

import { ModelSort } from '~/server/common/enums';
import { modelVersionUpsertSchema } from '~/server/schema/model-version.schema';
import { tagSchema } from '~/server/schema/tag.schema';
import { sanitizedStringSchema } from '~/server/schema/utils.schema';

export const getAllModelsSchema = z.object({
  limit: z.preprocess((val) => Number(val), z.number().min(0).max(200)).optional(),
  page: z.preprocess((val) => Number(val), z.number().min(1)).optional(),
  cursor: z.preprocess((val) => Number(val), z.number()).optional(),
  query: z.string().optional(),
  tag: z.string().optional(),
  user: z.string().optional(),
  username: z.string().optional(),
  types: z
    .union([z.nativeEnum(ModelType), z.nativeEnum(ModelType).array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel]))
    .optional(),
  sort: z.nativeEnum(ModelSort).default(ModelSort.HighestRated),
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
  rating: z
    .preprocess((val) => Number(val), z.number())
    .transform((val) => Math.floor(val))
    .optional(),
  favorites: z.preprocess((val) => val === 'true', z.boolean().optional().default(false)),
});

export type GetAllModelsInput = z.input<typeof getAllModelsSchema>;
export type GetAllModelsOutput = z.infer<typeof getAllModelsSchema>;

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
