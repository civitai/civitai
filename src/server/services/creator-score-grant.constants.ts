// The endpoint enforces these; a moderator-app form that pre-validates must use the same numbers.
export const CREATOR_SCORE_GRANT_LIMITS = {
  maxAmount: 10_000,
  dailyPerModerator: 20,
  maxReasonLength: 500,
} as const;
