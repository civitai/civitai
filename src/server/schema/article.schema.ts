import { MetricTimeframe } from '@prisma/client';
import { z } from 'zod';

import { constants } from '~/server/common/constants';
import { ArticleSort } from '~/server/common/enums';
import {
  baseQuerySchema,
  infiniteQuerySchema,
  periodModeSchema,
} from '~/server/schema/base.schema';
import { baseFileSchema } from '~/server/schema/file.schema';
import { tagSchema } from '~/server/schema/tag.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { imageSchema } from '~/server/schema/image.schema';

export const userPreferencesForArticlesSchema = z.object({
  excludedIds: z.array(z.number()).optional(),
  excludedUserIds: z.array(z.number()).optional(),
  excludedTagIds: z.array(z.number()).optional(),
});

export type ArticleQueryInput = z.input<typeof articleWhereSchema>;
export const articleWhereSchema = baseQuerySchema.extend({
  query: z.string().optional(),
  tags: z.array(z.number()).optional(),
  favorites: z.boolean().optional(),
  hidden: z.boolean().optional(),
  username: z.string().optional(),
  userIds: z.array(z.number()).optional(),
  period: z.nativeEnum(MetricTimeframe).default(constants.articleFilterDefaults.period),
  periodMode: periodModeSchema,
  sort: z.nativeEnum(ArticleSort).default(constants.articleFilterDefaults.sort),
  includeDrafts: z.boolean().optional(),
  ids: commaDelimitedNumberArray({ message: 'ids should be a number array' }).optional(),
  collectionId: z.number().optional(),
  followed: z.boolean().optional(),
  clubId: z.number().optional(),
  pending: z.boolean().optional(),
});

export type GetInfiniteArticlesSchema = z.infer<typeof getInfiniteArticlesSchema>;
export const getInfiniteArticlesSchema = infiniteQuerySchema
  .extend({ cursor: z.preprocess((val) => Number(val), z.number()).optional() })
  .merge(userPreferencesForArticlesSchema)
  .merge(articleWhereSchema);

export type UpsertArticleInput = z.infer<typeof upsertArticleInput>;
export const upsertArticleInput = z.object({
  id: z.number().optional(),
  title: z.string().min(1).max(100),
  content: getSanitizedStringSchema().refine((data) => {
    return data && data.length > 0 && data !== '<p></p>';
  }, 'Cannot be empty'),
  coverImage: imageSchema.nullish(),
  tags: z.array(tagSchema).nullish(),
  userNsfwLevel: z.number().default(0),
  publishedAt: z.date().nullish(),
  attachments: z.array(baseFileSchema).optional(),
  lockedProperties: z.string().array().optional(),
});
