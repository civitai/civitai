/**
 * "Request access" on `/apps/build`. Shared by the form, the tRPC schema and the moderator queue,
 * so the bounds a person types against are the bounds the server enforces.
 */

export const APP_ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'declined'] as const;
export type AppAccessRequestStatus = (typeof APP_ACCESS_REQUEST_STATUSES)[number];

/** The two outcomes a moderator can record. Declining an approved request revokes it. */
export const APP_ACCESS_REQUEST_DECISIONS = ['approved', 'declined'] as const;
export type AppAccessRequestDecision = (typeof APP_ACCESS_REQUEST_DECISIONS)[number];

/** "What do you want to build?" — long enough to say something, short enough to read in a queue. */
export const APP_ACCESS_WHAT_TO_BUILD_MIN = 20;
export const APP_ACCESS_WHAT_TO_BUILD_MAX = 2000;
