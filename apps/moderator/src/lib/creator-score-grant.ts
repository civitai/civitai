// Client-importable (no server imports). Mirrors CREATOR_SCORE_GRANT_LIMITS in the main app's
// src/server/services/creator-score-grant.constants.ts, which enforces them.

export const CREATOR_SCORE_GRANT_MAX_AMOUNT = 10_000;
/** With `user.creatorScore.grantLarge`. */
export const CREATOR_SCORE_GRANT_LARGE_MAX_AMOUNT = 1_000_000;
export const CREATOR_SCORE_GRANT_DAILY_CAP = 20;
export const CREATOR_SCORE_GRANT_REASON_MAX = 500;

export type CreatorScoreGrantResult =
  | { kind: 'granted'; amount: number; total: number }
  | { kind: 'revoked'; total: number };
