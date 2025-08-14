import { ReviewReactions } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { CacheTTL, constants } from '~/server/common/constants';

import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import type { RateLimit } from '~/server/middleware.trpc';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

export const commentRateLimits: RateLimit[] = [
  { limit: 10, period: CacheTTL.hour },
  { limit: 4 * 10, period: CacheTTL.day },
  { limit: 60, period: CacheTTL.hour, userReq: (user) => user.meta?.scores?.total >= 1000 },
  { limit: 8 * 60, period: CacheTTL.day, userReq: (user) => user.meta?.scores?.total >= 1000 },
];

export type GetAllCommentsSchema = z.infer<typeof getAllCommentsSchema>;
export const getAllCommentsSchema = z
  .object({
    limit: z.number().min(0).max(100),
    page: z.number(),
    cursor: z.number(),
    modelId: z.number(),
    userId: z.number(),
    filterBy: z.array(z.enum(ReviewFilter)),
    sort: z.enum(ReviewSort).default(ReviewSort.Newest),
    hidden: z.boolean().optional(),
  })
  .partial();

export type CommentUpsertInput = z.infer<typeof commentUpsertInput>;
export const commentUpsertInput = z.object({
  id: z.number().optional(),
  modelId: z.number(),
  commentId: z.number().nullish(),
  reviewId: z.number().nullish(),
  parentId: z.number().nullish(),
  content: getSanitizedStringSchema({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'span'],
  })
    .refine((data) => {
      return data && data.length > 0 && data !== '<p></p>';
    }, 'Cannot be empty')
    .refine((data) => data.length <= constants.comments.maxLength, 'Comment content too long'),
  hidden: z.boolean().nullish(),
});

export type GetCommentReactionsSchema = z.infer<typeof getCommentReactionsSchema>;
export const getCommentReactionsSchema = z.object({ commentId: z.number() });

export type GetCommentCountByModelInput = z.infer<typeof getCommentCountByModelSchema>;
export const getCommentCountByModelSchema = z.object({
  modelId: z.number(),
  hidden: z.boolean().optional(),
});

export type ToggleReactionInput = z.infer<typeof toggleReactionInput>;
export const toggleReactionInput = z.object({
  id: z.number(),
  reaction: z.enum(ReviewReactions),
});
