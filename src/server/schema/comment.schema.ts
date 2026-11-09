import { ReviewReactions } from '~/shared/utils/prisma/enums';
import * as z from 'zod';

import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { commentContentSchema } from '~/server/schema/commentv3.schema';

import { usageLimits } from '~/shared/constants/usage-limits';

export { COMMENT_RATE_LIMIT_MIN_CREATOR_SCORE } from '~/shared/constants/usage-limits';

export const commentRateLimits = usageLimits('comments.hourly', 'comments.daily');
/** The bucket comments on images, posts and articles count against, and the usage-limits read reads. */
export const COMMENT_V3_RATE_LIMIT_KEY = 'commentv3:write';

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
  content: commentContentSchema,
  hidden: z.boolean().nullish(),
});

export type GetCommentReactionsSchema = z.infer<typeof getCommentReactionsSchema>;
export const getCommentReactionsSchema = z.object({ commentId: z.number() });

export type GetCommentCountByModelInput = z.infer<typeof getCommentCountByModelSchema>;
export const getCommentCountByModelSchema = z.object({
  modelId: z.number(),
  hidden: z.boolean().optional(),
});

export type GetCommentCountsByModelInput = z.infer<typeof getCommentCountsByModelSchema>;
export const getCommentCountsByModelSchema = z.object({
  modelId: z.number(),
  /** `false` when the client already holds every visible comment: only the hidden count runs. */
  includeVisible: z.boolean().default(true),
});

export type ToggleReactionInput = z.infer<typeof toggleReactionInput>;
export const toggleReactionInput = z.object({
  id: z.number(),
  reaction: z.enum(ReviewReactions),
});
