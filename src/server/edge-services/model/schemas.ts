import { periodModeSchema } from '~/server/schema/base.schema';
import { constants } from '~/server/common/constants';
import { BrowsingMode, ModelSort } from '~/server/common/enums';
import { CheckpointType, ModelStatus, ModelType, MetricTimeframe } from '@prisma/client';
import { z } from 'zod';
import { postgresSlugify } from '~/utils/string-helpers';

export type GetAllInput = z.input<typeof getAllSchema>;
export type GetAllOutput = z.output<typeof getAllSchema>;
export const getAllSchema = z.object({
  take: z.coerce.number().min(0).max(200).default(100),
  cursor: z.coerce.number().optional(),
  query: z.string().optional(),
  tags: z
    .union([z.coerce.number(), z.coerce.number().array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel])),
  tagname: z.string().optional(),
  user: z.string().transform(postgresSlugify).optional(),
  username: z.string().transform(postgresSlugify).optional(),
  browsingMode: z.nativeEnum(BrowsingMode),
  types: z
    .union([z.nativeEnum(ModelType), z.nativeEnum(ModelType).array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel])),
  status: z
    .union([z.nativeEnum(ModelStatus), z.nativeEnum(ModelStatus).array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel])),
  checkpointType: z.nativeEnum(CheckpointType).optional(),
  baseModels: z
    .union([z.enum(constants.baseModels), z.enum(constants.baseModels).array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel])),
  sort: z.nativeEnum(ModelSort).default(constants.modelFilterDefaults.sort),
  period: z.nativeEnum(MetricTimeframe).default(constants.modelFilterDefaults.period),
  periodMode: periodModeSchema,
  rating: z.coerce.number().transform(Math.floor).optional(),
  favorites: z.coerce.boolean().optional(),
  hidden: z.coerce.boolean().optional(),
  needsReview: z.coerce.boolean().optional(),
  earlyAccess: z.coerce.boolean().optional(),
});
