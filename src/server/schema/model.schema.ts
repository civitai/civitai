import { ModelType, MetricTimeframe } from '@prisma/client';
import { z } from 'zod';
import { ModelSort } from '~/server/common/enums';

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
    showNsfw: z.boolean(),
  })
  .partial();

export type GetAllModelsArgs = z.infer<typeof getAllModelsSchema>;
