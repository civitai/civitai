import { MetricTimeframe, ModelType } from '@prisma/client';
import { z } from 'zod';

import { constants } from '~/server/common/constants';
import { BountySort } from '~/server/common/enums';
import { getAllQuerySchema } from '~/server/schema/base.schema';
import { imageSchema } from '~/server/schema/image.schema';
import { tagSchema } from '~/server/schema/tag.schema';

export const getAllBountiesSchema = getAllQuerySchema
  .extend({
    cursor: z.preprocess((val) => Number(val), z.number()),
    tag: z.string(),
    types: z
      .union([z.nativeEnum(ModelType), z.nativeEnum(ModelType).array()])
      .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel])),
    sort: z.nativeEnum(BountySort).default(constants.bountyFilterDefaults.sort),
    period: z.nativeEnum(MetricTimeframe).default(constants.bountyFilterDefaults.period),
    favorites: z.preprocess((val) => val === true || val === 'true', z.boolean().default(false)),
  })
  .partial();
export type GetAllBountiesSchema = z.infer<typeof getAllBountiesSchema>;

export const bountyFileSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.enum(constants.modelFileTypes),
});

export const bountyUpsertSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  description: z.string(),
  type: z.nativeEnum(ModelType),
  deadline: z.date(),
  nsfw: z.boolean(),
  poi: z.boolean(),
  images: z.array(imageSchema).min(1, 'At least one example image must be uploaded'),
  tags: z.array(tagSchema).nullish(),
  files: z.array(bountyFileSchema).min(1, 'At least one file must be uploaded').max(1),
});
export type BountyUpsertSchema = z.infer<typeof bountyUpsertSchema>;
