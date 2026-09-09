/**
 * Shared with the panel, not kept in `$lib/server/`, because the number is stated to the moderator
 * reading the highlight it produces — and a threshold described in prose drifts from the one applied
 * in SQL the first time either moves. Same reason `$lib/permissions.ts` sits out here.
 */

/** Volume below which a negative-heavy reaction mix is noise rather than a pattern worth acting on. */
export const MIN_FLAGGED = 20;
