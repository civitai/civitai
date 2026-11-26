/**
 * Who reviewed an app — the byline the app-review notifications (`app-block-approved` /
 * `-rejected`, `app-listing-approved` / `-rejected` / `-hidden`) carry, so a decision reads as
 * coming from a person rather than from the platform.
 *
 * What is STORED on the notification is the fact the emitter knew: the deciding moderator's
 * `reviewerUserId`, or `reviewedAutomatically: true` for a decision no person made. The
 * reviewer's name and avatar are NOT stored: `appReviewDetailFetcher` resolves them into
 * `actor` when the notification is read or emailed, so a renamed reviewer shows the current
 * name and a deleted one shows none.
 *
 * Pure and dependency-free: the processors that call it are in the client graph.
 */

export const APP_REVIEW_TEAM_NAME = 'Civitai App Review';

/** How an emitter states who decided. A decision path must name one; nothing is inferred. */
export type AppReviewAttribution = { kind: 'moderator'; userId: number } | { kind: 'automated' };

/** The reviewer as `appReviewDetailFetcher` resolves it (a live account only). */
export type AppReviewActor = {
  username?: string | null;
  deletedAt?: Date | string | null;
};

export type AppReviewAttributionDetails = {
  /** The moderator who decided. Absent on notifications sent before attribution existed. */
  reviewerUserId?: number | null;
  /** The decision was made by an automated review, not a person. */
  reviewedAutomatically?: boolean;
  /** Filled at read time by `appReviewDetailFetcher`; never stored. */
  actor?: AppReviewActor | null;
};

/** The details fields an emitter stores for `attribution`. */
export function appReviewAttributionDetails(
  attribution: AppReviewAttribution | undefined
): Pick<AppReviewAttributionDetails, 'reviewerUserId' | 'reviewedAutomatically'> {
  if (!attribution) return {};
  return attribution.kind === 'automated'
    ? { reviewedAutomatically: true }
    : { reviewerUserId: attribution.userId };
}

/**
 * "Reviewed by @name, Civitai App Review", "Reviewed automatically by Civitai App Review", or,
 * when the reviewer's account is gone, "Reviewed by Civitai App Review". `undefined` for a
 * notification that predates attribution, which then renders exactly as it did.
 */
export function appReviewByline(details: AppReviewAttributionDetails): string | undefined {
  if (details.reviewedAutomatically === true) {
    return `Reviewed automatically by ${APP_REVIEW_TEAM_NAME}`;
  }
  const actor = details.actor;
  const username = typeof actor?.username === 'string' ? actor.username.trim() : '';
  if (username && !actor?.deletedAt) return `Reviewed by @${username}, ${APP_REVIEW_TEAM_NAME}`;
  if (typeof details.reviewerUserId === 'number') return `Reviewed by ${APP_REVIEW_TEAM_NAME}`;
  return undefined;
}

/** Appends the reviewer's approval note to `message` when one is present. */
export function withApprovalNote(message: string, note?: string | null): string {
  const trimmed = typeof note === 'string' ? note.trim() : '';
  return trimmed ? `${message} Note from the reviewer: ${trimmed}` : message;
}

/**
 * The moderator who decided a request, as the app's own team sees it on the site: name and
 * avatar only (no id), rendered "Reviewed by @name, Civitai App Review". `account: null` when the
 * reviewer's account is gone, which renders "Reviewed by Civitai App Review".
 */
export type DecisionReviewer = {
  account: { username: string | null; image: string | null } | null;
};

/**
 * A request's `reviewedBy` relation, read through `reviewUserChipSelect`. Its `id` is read but
 * never projected: `decisionReviewer` passes on the name and avatar only.
 */
export type DecisionReviewerRow = {
  id?: number;
  username: string | null;
  image: string | null;
  deletedAt: Date | null;
} | null;

const DECIDED_STATUSES: ReadonlySet<string> = new Set(['approved', 'rejected']);

/** The reviewer of a decided request; `null` for one nobody has decided (pending, withdrawn). */
export function decisionReviewer(
  status: string,
  reviewedBy: DecisionReviewerRow | undefined
): DecisionReviewer | null {
  if (!DECIDED_STATUSES.has(status)) return null;
  if (!reviewedBy || reviewedBy.deletedAt || !reviewedBy.username) return { account: null };
  return { account: { username: reviewedBy.username, image: reviewedBy.image } };
}
