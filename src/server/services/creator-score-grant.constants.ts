// The moderator app keeps a client-safe copy of these in `apps/moderator/src/lib/creator-score-grant.ts`.
export const CREATOR_SCORE_GRANT_LIMITS = {
  maxAmount: 10_000,
  dailyPerModerator: 20,
  maxReasonLength: 500,
} as const;
