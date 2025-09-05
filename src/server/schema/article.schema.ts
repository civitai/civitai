import { ArticleStatus, MetricTimeframe } from '~/shared/utils/prisma/enums';
import * as z from 'zod';

import { CacheTTL, constants } from '~/server/common/constants';
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
import type { RateLimit } from '~/server/middleware.trpc';
import { isBetweenToday } from '~/utils/date-helpers';

export const articleRateLimits: RateLimit[] = [
  {
    limit: 0,
    period: CacheTTL.hour,
    // Users can't create articles if they were created less than 24hrs ago
    userReq: (user) => !!user.createdAt && isBetweenToday(user.createdAt),
    errorMessage: 'You need to wait 24 hours after creating your account to create articles.',
  },
  {
    limit: 1,
    period: CacheTTL.day,
  },
  {
    limit: 2,
    period: CacheTTL.day,
    userReq: (user) => (user.meta?.scores?.articles ?? 0) >= 1000,
  },
  {
    limit: 10,
    period: CacheTTL.day,
    userReq: (user) => (user.meta?.scores?.articles ?? 0) >= 10000,
  },
];

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
  period: z.enum(MetricTimeframe).default(constants.articleFilterDefaults.period),
  periodMode: periodModeSchema,
  sort: z.enum(ArticleSort).default(constants.articleFilterDefaults.sort),
  includeDrafts: z.boolean().optional(),
  ids: commaDelimitedNumberArray().optional(),
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
  status: z.enum(ArticleStatus).optional(),
});
