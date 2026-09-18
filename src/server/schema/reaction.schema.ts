import { ReviewReactions } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import type { RateLimit } from '~/server/middleware.trpc';

export const reactionRateLimits: RateLimit[] = [
  // 1 minute limit - allow rapid interactions but prevent botting (60 reactions/min = 1 per second)
  { limit: 60, period: CacheTTL.xs },
  // 10 minute limit - accommodate active browsing with multiple reaction types
  { limit: 300, period: CacheTTL.md },
  // 1 hour limit - normal browsing patterns with reaction changes
  { limit: 1000, period: CacheTTL.hour },
  // 24 hour limit - prevent systematic abuse while allowing heavy usage
  { limit: 5000, period: CacheTTL.day },
  // Higher limits for users with good reputation scores (≥1000 total score)
  { limit: 100, period: CacheTTL.xs, userReq: (user) => (user.meta?.scores?.total ?? 0) >= 1000 },
  { limit: 500, period: CacheTTL.md, userReq: (user) => (user.meta?.scores?.total ?? 0) >= 1000 },
  {
    limit: 1500,
    period: CacheTTL.hour,
    userReq: (user) => (user.meta?.scores?.total ?? 0) >= 1000,
  },
  { limit: 8000, period: CacheTTL.day, userReq: (user) => (user.meta?.scores?.total ?? 0) >= 1000 },
];

// `as const` (not `readonly [string, ...string[]]`) so `ReactionEntityType` stays a
// literal union — the block-check owner resolver switches exhaustively over it.
export const reactableEntities = [
  'question',
  'answer',
  'comment',
  'commentOld',
  'image',
  'post',
  'resourceReview',
  'article',
  'bountyEntry',
] as const;

/**
 * Cap matches `getStickerPlacementsSchema`, the other per-viewer batch a feed surface makes, so
 * both chunk at the same size. The client chunks rather than truncating: a partially hydrated
 * grid leaves the un-hydrated cards showing an un-given reaction, which is the state that gets a
 * viewer to click their own reaction off again.
 */
export type GetMyImageReactionsInput = z.infer<typeof getMyImageReactionsSchema>;
export const getMyImageReactionsSchema = z.object({
  imageIds: z.array(z.number()).min(1).max(100),
});

export type ReactionEntityType = ToggleReactionInput['entityType'];
export type ToggleReactionInput = z.infer<typeof toggleReactionSchema>;
export const toggleReactionSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(reactableEntities),
  reaction: z.enum(ReviewReactions),
});
