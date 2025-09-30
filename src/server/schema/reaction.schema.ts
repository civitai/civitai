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
  { limit: 100, period: CacheTTL.xs, userReq: (user) => user.meta?.scores?.total >= 1000 },
  { limit: 500, period: CacheTTL.md, userReq: (user) => user.meta?.scores?.total >= 1000 },
  { limit: 1500, period: CacheTTL.hour, userReq: (user) => user.meta?.scores?.total >= 1000 },
  { limit: 8000, period: CacheTTL.day, userReq: (user) => user.meta?.scores?.total >= 1000 },
];

export const reactableEntities: readonly [string, ...string[]] = [
  'question',
  'answer',
  'comment',
  'commentOld',
  'image',
  'post',
  'resourceReview',
  'article',
  'bountyEntry',
  'clubPost',
];

export type ReactionEntityType = ToggleReactionInput['entityType'];
export type ToggleReactionInput = z.infer<typeof toggleReactionSchema>;
export const toggleReactionSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(reactableEntities),
  reaction: z.enum(ReviewReactions),
});
