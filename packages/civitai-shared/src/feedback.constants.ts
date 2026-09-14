// The in-product feedback surface's shared constants. Pure strings and numbers, no DB / env /
// framework deps, so the Next producer AND the `apps/moderator` triage queue can both read them —
// the moderator app used to hand-mirror `FEEDBACK_AREAS` because it could not reach this file, and
// nothing kept the two in step. `~/shared/constants/feedback.constants` is a re-export shim, so
// every existing main-app import path still resolves.
//
// Plain strings, not a Prisma enum: adding an area costs a constant here and no
// migration, and its Flipt flag is derived from the slug.
//
// 🔴 `bitdex-image-feed` has no producer — BitDex was decommissioned 2026-09-01 and
// its prompt went with it. KEEP IT ANYWAY. `Feedback.area` is a stored string column
// and this list is the only place its valid labels are written down, so dropping the
// slug orphans every historical row filed under it. Nothing in the app mounts a
// prompt that writes it and its area flag is off, so it cannot grow.
// Enforced: `feedback.schema.test.ts` compares a hand-typed list against this one,
// so removing the slug fails there with an array diff rather than silently.
export const FEEDBACK_AREAS = ['bitdex-image-feed', 'apps-marketplace', 'site-bug-report'] as const;

/**
 * The area behind the support menu's "Report a bug", and the only one that is not
 * tied to a single page — it is reachable from the footer on every route, so its
 * `context.path` is the only thing that says where the report came from.
 */
export const SITE_BUG_REPORT_AREA: FeedbackArea = 'site-bug-report';

export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;

export const FEEDBACK_RATE_LIMIT = { max: 5, periodSeconds: 60 * 60 };

/**
 * Attachments a single submission may carry.
 *
 * A storage bound first: `context` is a JSONB column and every value in it is
 * client-supplied, so an unbounded array is a write-amp vector regardless of what
 * the UI does. The UI cap is a convenience on top. There is no companion
 * id-LENGTH bound — an image id is bounded by SHAPE (`z.uuid()`) in
 * `feedback.schema.ts`, which fixes its length at 36 and is a security guard
 * besides; see the field note there.
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

/**
 * Length ceiling on `context.path`.
 *
 * Exported for the same reason as FEEDBACK_FILTER_VALUE_MAX_LENGTH below: a caller
 * has to clip to it, and `feedbackContextSchema` REJECTS an over-long value rather
 * than clipping, so a drifted copy fails the whole submission on the surface that
 * exists to collect reports.
 */
export const FEEDBACK_PATH_MAX_LENGTH = 300;

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

/**
 * The browser-telemetry snapshot: how many console errors and failed requests a submission may
 * carry, and how long each captured string may be.
 *
 * 🔴 THESE ARE A PRIVACY BOUND FIRST AND A STORAGE BOUND SECOND, which is the opposite reading
 * from every other constant in this file. A console error routinely carries a URL with its query
 * parameters, an auth failure, or a fragment of whatever the page was rendering — and `context` is
 * a JSONB column with no retention policy, read by moderators. So the ceiling is not "what fits",
 * it is "how much of a stranger's session is it proportionate to keep forever to triage one bug".
 * Ten entries is roughly one screenful; it is deliberately not fifty.
 *
 * Worst case per row, which is the number to re-derive if either is widened:
 *   10 × 300  = 3.0 KB of console text
 * + 10 × ~330 = 3.3 KB of network entries (url + initiatorType + status)
 *   ≈ 6.3 KB, against a `FEEDBACK_MESSAGE_MAX_LENGTH` of 2000.
 *
 * As everywhere else here, `feedbackContextSchema` REJECTS an over-count or over-length value
 * rather than clipping it, so the CAPTURE side must clip to these numbers — see
 * `src/utils/feedback/browserErrorLog.ts`, which is why they are exported rather than inline.
 */
export const FEEDBACK_CONSOLE_ERROR_MAX_COUNT = 10;
export const FEEDBACK_CONSOLE_ERROR_MAX_LENGTH = 300;
export const FEEDBACK_NETWORK_ERROR_MAX_COUNT = 10;

/**
 * Length ceiling on ONE captured request URL.
 *
 * Separate from `FEEDBACK_PATH_MAX_LENGTH` even though both are 300 today: that one bounds a bare
 * same-origin pathname, this one bounds an `origin + pathname` with the query string already
 * stripped, and a third-party origin can be long. Coupling them would make widening one silently
 * widen the other.
 */
export const FEEDBACK_NETWORK_URL_MAX_LENGTH = 300;

/**
 * Length ceiling on `initiatorType`.
 *
 * It is a closed set in the Resource Timing spec (`fetch`, `xmlhttprequest`, `img`, `script`,
 * `css`, `link`, `other`, …), so this bound should never fire. It is here because the value still
 * arrives from a client and the field is still a JSONB leaf — bounded by length rather than by an
 * enum so a browser that adds a new initiator type degrades to storing it, not to a rejected
 * submission on the surface that exists to collect reports.
 */
export const FEEDBACK_NETWORK_INITIATOR_MAX_LENGTH = 20;

export const feedbackAreaFlagKey = (area: FeedbackArea) => `feedback-area-${area}`;
