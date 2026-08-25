/**
 * The strike escalation thresholds, in active strike points.
 *
 * At or above REVIEW_MUTE_POINTS the account is flagged for a moderator to decide on; at or above
 * MUTE_POINTS it is muted until it re-accepts the Terms or the points decay.
 *
 * Here rather than in `strike.service.ts` because consumers outside the strike system need them —
 * challenge eligibility gates on the same "is this account sanctioned" line, and importing the
 * service for a number would drag its notification and email graph into every caller.
 */
export const MUTE_POINTS = 2;
export const REVIEW_MUTE_POINTS = 3;
