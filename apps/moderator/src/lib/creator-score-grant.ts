// Shared by the panel, its form actions and the service, and free of server imports so the panel can
// read it. These mirror `src/server/services/creator-score-grant.constants.ts` in the main app, which
// is what enforces them: a drift here only makes the form offer or refuse the wrong values.

export const CREATOR_SCORE_GRANT_MAX_AMOUNT = 10_000;
export const CREATOR_SCORE_GRANT_DAILY_CAP = 20;
export const CREATOR_SCORE_GRANT_REASON_MAX = 500;
