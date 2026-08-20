// Plain strings, not a Prisma enum: adding an area costs a constant here and no
// migration, and its Flipt flag is derived from the slug.
export const FEEDBACK_AREAS = ['bitdex-image-feed', 'apps-marketplace'] as const;

export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;

export const FEEDBACK_RATE_LIMIT = { max: 5, periodSeconds: 60 * 60 };

/**
 * Attachments a single submission may carry, and the length of one stored id.
 *
 * Both are storage bounds first: `context` is a JSONB column and every value in it
 * is client-supplied, so an unbounded array or an unbounded string is a write-amp
 * vector regardless of what the UI does. The UI cap is a convenience on top.
 *
 * UPLOAD BUDGET. The prompt uploads nothing until Send is pressed, so the feedback
 * surface can mint at most `FEEDBACK_IMAGE_MAX_COUNT + 1` Cloudflare uploads per
 * submit attempt (attachments plus the opt-in screenshot), and a user who stays
 * inside the 5-per-hour submit limit tops out at
 * `FEEDBACK_RATE_LIMIT.max * (FEEDBACK_IMAGE_MAX_COUNT + 1)` = 20 uploads/hour.
 * That is a bound on the SUCCESSFUL path only: the rate limiter runs on the tRPC
 * mutation, which is after the uploads, so a user who keeps re-pressing Send past
 * the limit still spends uploads. `/api/v1/image-upload` carries no quota of its
 * own today (any signed-in user can already mint upload URLs from anywhere in the
 * app), so closing that is a change to that endpoint, not to this constant.
 */
export const FEEDBACK_IMAGE_MAX_COUNT = 3;

/** Cloudflare image ids written here are `randomUUID()` (36 chars); this is headroom, not a fit. */
export const FEEDBACK_IMAGE_ID_MAX_LENGTH = 100;

/** Faro session ids are short opaque strings; bounded because it is still client-supplied. */
export const FEEDBACK_SESSION_ID_MAX_LENGTH = 64;

/**
 * Length ceiling on ONE value inside `context.filters`.
 *
 * Named rather than left inline in the schema because a caller has to TRUNCATE to it,
 * and a caller truncating to a number the schema does not publish is a drift waiting
 * to happen. The concrete case: `/apps` puts its free-text search box in the URL
 * (`?query=…`), so the value the marketplace prompt reports is user-typed and
 * unbounded. `feedbackContextSchema` REJECTS an over-long value — it does not clip it
 * — so an untruncated report would fail the whole submission with a validation error
 * the reporter cannot act on, on the exact surface that exists to collect reports.
 * Same reading as every other bound here: `context` is a JSONB column and everything
 * in it is client-supplied.
 */
export const FEEDBACK_FILTER_VALUE_MAX_LENGTH = 200;

export const feedbackAreaFlagKey = (area: FeedbackArea) => `feedback-area-${area}`;
