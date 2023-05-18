import { MetricTimeframe } from '@prisma/client';
import { z } from 'zod';

import { constants } from '~/server/common/constants';
import { ArticleSort, BrowsingMode } from '~/server/common/enums';
import { getAllQuerySchema } from '~/server/schema/base.schema';
import { baseFileSchema } from '~/server/schema/file.schema';
import { tagSchema } from '~/server/schema/tag.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

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
  userIds: z.array(z.number()).optional(),
  excludedIds: z.array(z.number()).optional(),
  favorites: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

export type UpsertArticleInput = z.infer<typeof upsertArticleInput>;
export const upsertArticleInput = z.object({
  id: z.number().optional(),
  title: z.string().min(1).max(100),
  content: getSanitizedStringSchema().refine((data) => {
    return data && data.length > 0 && data !== '<p></p>';
  }, 'Cannot be empty'),
  cover: z.string().min(1),
  tags: z.array(tagSchema).nullish(),
  nsfw: z.boolean().optional(),
  publishedAt: z.date().nullish(),
  attachments: z.array(baseFileSchema).optional(),
  // TODO.articles: check what's going to be stored on metadata
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
