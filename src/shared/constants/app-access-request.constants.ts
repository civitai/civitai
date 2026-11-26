/**
 * "Request access" on `/apps/build`. Shared by the form, the tRPC schema and the moderator queue,
 * so the bounds a person types against are the bounds the server enforces.
 */

export const APP_ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'declined'] as const;
export type AppAccessRequestStatus = (typeof APP_ACCESS_REQUEST_STATUSES)[number];

/** Who decided a request: a moderator's `decide`, or `app-access-auto-approve` on submit. */
export const APP_ACCESS_REVIEW_SOURCES = ['moderator', 'system'] as const;
export type AppAccessReviewSource = (typeof APP_ACCESS_REVIEW_SOURCES)[number];

/** The two outcomes a moderator can record. Declining an approved request revokes it. */
export const APP_ACCESS_REQUEST_DECISIONS = ['approved', 'declined'] as const;
export type AppAccessRequestDecision = (typeof APP_ACCESS_REQUEST_DECISIONS)[number];

/**
 * How old an account must be, in days, before `app-access-auto-approve` may approve its request on
 * submit. A younger account still gets a request, PENDING, for a moderator to decide: the age check
 * routes it to the queue, it never declines it.
 */
export const APP_ACCESS_AUTO_APPROVE_MIN_ACCOUNT_AGE_DAYS = 7;

/** "What do you want to build?" — optional, and short enough to read in a queue. */
export const APP_ACCESS_WHAT_TO_BUILD_MAX = 2000;

/**
 * Where the moderator queue lives: the "Access requests" tab on `/apps/review`. Read by the old
 * `/moderator/app-access-requests` route (which redirects here) and the moderation nav, so the two
 * cannot point at different places. The tab value must stay in `/apps/review`'s `TAB_VALUES`, or
 * the link lands on Pending.
 */
export const APP_ACCESS_REQUESTS_REVIEW_HREF = '/apps/review?tab=access-requests';

/**
 * `/apps/build?request-access=1` opens the Request access form (signing the viewer in first when
 * needed). Linked from outside the site (the CLI README), so the name is a public contract: keep it.
 */
export const REQUEST_ACCESS_PARAM = 'request-access';
