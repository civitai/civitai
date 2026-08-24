/**
 * The strike escalation thresholds, in active strike points.
 *
 * At or above INDEFINITE_MUTE_POINTS the mute has no expiry and the account is flagged for moderator
 * review; at or above TIMED_MUTE_POINTS it expires after TIMED_MUTE_DAYS; below that, a mute the
 * escalation engine applied earlier is lifted again.
 *
 * Here rather than in `strike.service.ts` because consumers outside the strike system need them —
 * challenge eligibility gates on the same "is this account sanctioned" line, and importing the
 * service for a number would drag its notification and email graph into every caller.
 */
export const TIMED_MUTE_POINTS = 2;
export const INDEFINITE_MUTE_POINTS = 3;
export const TIMED_MUTE_DAYS = 3;
