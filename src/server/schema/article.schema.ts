import { MetricTimeframe } from '@prisma/client';
import { z } from 'zod';

import { constants } from '~/server/common/constants';
import { ArticleSort, BrowsingMode } from '~/server/common/enums';
import { getAllQuerySchema } from '~/server/schema/base.schema';
import { tagSchema } from '~/server/schema/tag.schema';

export type GetInfiniteArticlesSchema = z.infer<typeof getInfiniteArticlesSchema>;
export const getInfiniteArticlesSchema = getAllQuerySchema.extend({
  page: z.never().optional(),
  cursor: z.number().optional(),
  period: z.nativeEnum(MetricTimeframe).default(constants.articleFilterDefaults.period),
  sort: z.nativeEnum(ArticleSort).default(constants.articleFilterDefaults.sort),
  browsingMode: z.nativeEnum(BrowsingMode).default(constants.articleFilterDefaults.browsingMode),
  tags: z.array(z.number()).optional(),
  excludedUserIds: z.array(z.number()).optional(),
  excludedTagIds: z.array(z.number()).optional(),
});

export type UpsertArticleInput = z.infer<typeof upsertArticleInput>;
export const upsertArticleInput = z.object({
  id: z.number().optional(),
  title: z.string().min(1).max(100),
  content: z.string().min(1),
  cover: z.string().url().nullish(),
  tags: z.array(tagSchema).nullish(),
  nsfw: z.boolean().optional(),
  publishedAt: z.date().nullish(),
  // metadata: z.object({}).nullish(),
});

export type GetArticlesByCategorySchema = z.infer<typeof getArticlesByCategorySchema>;
export const getArticlesByCategorySchema = z.object({
  limit: z.number().min(1).max(30).optional(),
  articleLimit: z.number().min(1).max(30).optional(),
  cursor: z.preprocess((val) => Number(val), z.number()).optional(),
  period: z.nativeEnum(MetricTimeframe).default(constants.articleFilterDefaults.period),
  sort: z.nativeEnum(ArticleSort).default(constants.articleFilterDefaults.sort),
  browsingMode: z.nativeEnum(BrowsingMode).default(constants.articleFilterDefaults.browsingMode),
  excludedUserIds: z.array(z.number()).optional(),
  excludedTagIds: z.array(z.number()).optional(),
});
