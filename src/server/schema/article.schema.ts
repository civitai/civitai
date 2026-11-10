import { ArticleStatus, MetricTimeframe } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { usageLimits } from '~/shared/constants/usage-limits';

import { CacheTTL, constants } from '~/server/common/constants';
import { ArticleSort, NsfwLevel } from '~/server/common/enums';
import {
  baseQuerySchema,
  infiniteQuerySchema,
  periodModeSchema,
} from '~/server/schema/base.schema';
import { baseFileSchema } from '~/server/schema/file.schema';
import { tagSchema } from '~/server/schema/tag.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { imageReferenceInputSchema } from '~/server/schema/image.schema';
import type { RateLimit } from '~/server/middleware.trpc';
import type { ArticleUnpublishReason } from '~/server/common/moderation-helpers';
import { articleUnpublishReasons } from '~/server/common/moderation-helpers';
import { browsingLevels } from '~/shared/constants/browsingLevel.constants';

const UnpublishReasons = Object.keys(articleUnpublishReasons) as [
  ArticleUnpublishReason,
  ...ArticleUnpublishReason[]
];

export const articleRateLimits = usageLimits('articles.first-day', 'articles.daily');

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
  pending: z.boolean().optional(),
});

// Composite keyset cursor for stable feed pagination. `v` is the primary sort
// value (rank column or publishedAt/updatedAt epoch); `id` is the article-id
// tiebreaker. Without the tiebreaker, ranked sorts (MostBookmarks, etc.) would
// terminate after a single page whenever the last row had a NULL rank — see
// getArticles for the traversal logic.
export const articleCursorSchema = z.object({
  v: z.coerce.number(),
  id: z.coerce.number(),
});
export type ArticleCursor = z.infer<typeof articleCursorSchema>;

export type GetInfiniteArticlesSchema = z.infer<typeof getInfiniteArticlesSchema>;
export const getInfiniteArticlesSchema = infiniteQuerySchema
  .extend({ cursor: articleCursorSchema.optional() })
  .merge(userPreferencesForArticlesSchema)
  .merge(articleWhereSchema);

export type UpsertArticleInput = z.infer<typeof upsertArticleInput>;
export const upsertArticleInput = z.object({
  id: z.number().optional(),
  title: z.string().min(1).max(100),
  content: getSanitizedStringSchema({ allowBlurbs: true }).refine((data) => {
    return data && data.length > 0 && data !== '<p></p>';
  }, 'Cannot be empty'),
  coverImage: imageReferenceInputSchema.nullish(),
  // Omitted leaves the banner as it is; null removes it.
  bannerImage: imageReferenceInputSchema.nullish(),
  tags: z.array(tagSchema).nullish(),
  userNsfwLevel: z.enum(NsfwLevel).default(NsfwLevel.PG),
  moderatorNsfwLevel: z.enum(NsfwLevel).nullish(),
  publishedAt: z.date().nullish(),
  // A date schedules a never-published draft to go live then; null cancels; omitted leaves it.
  scheduledAt: z.date().nullish(),
  attachments: z.array(baseFileSchema).optional(),
  lockedProperties: z.string().array().optional(),
  status: z.enum(ArticleStatus).optional(),
  // Moderator-only. `upsertArticleHandler` DROPS this field for everyone else rather
  // than refusing the save — see the comment there for why refusing is the wrong shape.
  isOfficial: z.boolean().optional(),
});

export type ResolveArticleImageScanInput = z.infer<typeof resolveArticleImageScanSchema>;
export const resolveArticleImageScanSchema = z.object({
  articleId: z.number(),
  imageId: z.number(),
  // Only real browsing levels (PG..XXX). Rejects Blocked (32) / 0 so a crafted
  // request can't pair an inconsistent nsfwLevel with ingestion=Scanned.
  nsfwLevel: z.number().refine((v) => (browsingLevels as readonly number[]).includes(v), {
    message: 'Invalid browsing level',
  }),
});

export type RescanArticleImageInput = z.infer<typeof rescanArticleImageSchema>;
export const rescanArticleImageSchema = z.object({
  articleId: z.number(),
  imageId: z.number(),
});

export type ArticleMetadata = {
  theme?: string;
  prizes?: Array<{ buzz: number; points: number }>;
  status?: string;
  userId?: number;
  modelId?: number;
  winners?: number[];
  entryPrize?: { buzz: number; points: number };
  invitation?: string;
  reviewedAt?: number; // timestamp
  collectionId?: number;
  challegeDate?: Date;
  challengeType?: string;
  entryPrizeRequirements?: number;
  unpublishedReason?: string;
  customMessage?: string;
  unpublishedAt?: string;
  unpublishedBy?: number;
  /** Set when a block moves a draft to UnpublishedViolation; a restore returns it here. */
  statusBeforeViolation?: 'Draft' | 'Unpublished' | 'Published';
};

export const unpublishArticleSchema = z.object({
  id: z.number(),
  reason: z
    .custom<ArticleUnpublishReason>((x) => UnpublishReasons.includes(x as ArticleUnpublishReason))
    .optional(),
  customMessage: z.string().optional(),
});

export type UnpublishArticleSchema = z.infer<typeof unpublishArticleSchema>;

export type SetArticleOfficialInput = z.infer<typeof setArticleOfficialSchema>;
export const setArticleOfficialSchema = z.object({
  id: z.number(),
  isOfficial: z.boolean(),
});

export const articleShareExpiryDays = [1, 7, 30] as const;
export const createArticleShareLinkSchema = z.object({
  articleId: z.number(),
  expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
});
export const getArticleShareLinksSchema = z.object({ articleId: z.number() });
// 32 random bytes in base64url is 43 characters; anything else cannot be a token.
export const shareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const openShareLinkSchema = z.object({ shareToken: shareTokenSchema });
export const getSharedArticleSchema = z.object({ articleId: z.number().int().positive() });
export const articleShareTokenRateLimits: RateLimit[] = [{ limit: 30, period: CacheTTL.xs }];
// Each create submits the draft text for a scan, so this bounds scan load.
export const articleShareCreateRateLimits: RateLimit[] = [{ limit: 10, period: CacheTTL.hour }];
