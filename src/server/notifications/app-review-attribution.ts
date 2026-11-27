/**
 * Who reviewed an app — the byline the app-review notifications (`app-block-approved` /
 * `-rejected`, `app-listing-approved` / `-rejected`) carry, so a decision reads as coming from a
 * person rather than from the platform. `app-listing-hidden` (a takedown) carries the team only.
 *
 * What is STORED on the notification names no account. A moderator's decision stores
 * `reviewedByModerator: true` and `reviewRequestId`, the publish request that was decided; an
 * automated one `reviewedAutomatically: true`; a team-attributed one `reviewedByTeam: true`.
 * `appReviewDetailFetcher` resolves the reviewer server-side from that request's
 * `reviewedByUserId` into `actor` when the notification is read or emailed, so a renamed
 * reviewer shows the current name and a deleted one shows none. The stored details also go to
 * the browser as they are (the realtime new-notification push), which is why no reviewer id is
 * stored: there is nothing for that path to leak.
 *
 * Notifications sent before this carry the moderator's `reviewerUserId` instead. The fetcher
 * still resolves it and removes it from what it returns.
 *
 * Pure and dependency-free: the processors that call it are in the client graph.
 */

import { isDecidedReviewStatus } from '~/shared/utils/app-review-thread';

export const APP_REVIEW_TEAM_NAME = 'Civitai App Review';

/**
 * How an emitter states who decided. A decision path must name one; nothing is inferred.
 *
 * `moderator` names the publish request that was decided (`AppBlockPublishRequest` for an
 * `app-block-*` notification, `AppListingPublishRequest` for an `app-listing-*` one); its
 * `reviewedByUserId` is the reviewer. It carries no account id, so none can be stored.
 *
 * `team` names no individual and stores no moderator id. It is what a TAKEDOWN uses
 * (`app-listing-hidden`): the owner of a taken-down listing is never told which moderator acted,
 * the same rule the owner's moderation history follows (`ownerModerationEventSelect`).
 */
export type AppReviewAttribution =
  | { kind: 'moderator'; requestId: string }
  | { kind: 'automated' }
  | { kind: 'team' };

/** The reviewer as `appReviewDetailFetcher` resolves it (a live account only). */
export type AppReviewActor = {
  username?: string | null;
  deletedAt?: Date | string | null;
};

export type AppReviewAttributionDetails = {
  /**
   * LEGACY: the moderator who decided, as notifications sent before `reviewRequestId` stored it.
   * Never written now; read only by `appReviewDetailFetcher`, which removes it.
   */
  reviewerUserId?: number | null;
  /**
   * The publish request a moderator decided. `appReviewDetailFetcher` reads its reviewer and
   * removes this from what it returns.
   */
  reviewRequestId?: string | null;
  /** The decision was made by an automated review, not a person. */
  reviewedAutomatically?: boolean;
  /** The decision is attributed to the team, naming no individual (a takedown). */
  reviewedByTeam?: boolean;
  /** Filled at read time by `appReviewDetailFetcher`; never stored. */
  actor?: AppReviewActor | null;
  /**
   * A person decided, so the byline falls back to the team when no actor resolved (the account
   * is gone). Stored on a moderator decision; also set by `appReviewDetailFetcher` on a legacy
   * notification in place of the `reviewerUserId` it removes.
   */
  reviewedByModerator?: boolean;
};

/** The details fields an emitter stores for `attribution`. */
export function appReviewAttributionDetails(
  attribution: AppReviewAttribution | undefined
): Pick<
  AppReviewAttributionDetails,
  'reviewRequestId' | 'reviewedByModerator' | 'reviewedAutomatically' | 'reviewedByTeam'
> {
  if (!attribution) return {};
  if (attribution.kind === 'automated') return { reviewedAutomatically: true };
  if (attribution.kind === 'team') return { reviewedByTeam: true };
  return { reviewedByModerator: true, reviewRequestId: attribution.requestId };
}

/**
 * "Reviewed by @name, Civitai App Review", "Reviewed automatically by Civitai App Review", or
 * "Reviewed by Civitai App Review" — for a team attribution, and when the reviewer's account is
 * gone. `undefined` for a
 * notification that predates attribution, which then renders exactly as it did.
 */
export function appReviewByline(details: AppReviewAttributionDetails): string | undefined {
  if (details.reviewedAutomatically === true) {
    return `Reviewed automatically by ${APP_REVIEW_TEAM_NAME}`;
  }
  if (details.reviewedByTeam === true) return `Reviewed by ${APP_REVIEW_TEAM_NAME}`;
  const actor = details.actor;
  const username = typeof actor?.username === 'string' ? actor.username.trim() : '';
  if (username && !actor?.deletedAt) return `Reviewed by @${username}, ${APP_REVIEW_TEAM_NAME}`;
  if (typeof details.reviewerUserId === 'number' || details.reviewedByModerator === true) {
    return `Reviewed by ${APP_REVIEW_TEAM_NAME}`;
  }
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

/** The reviewer of a decided request; `null` for one nobody has decided (pending, withdrawn). */
export function decisionReviewer(
  status: string,
  reviewedBy: DecisionReviewerRow | undefined
): DecisionReviewer | null {
  if (!isDecidedReviewStatus(status)) return null;
  if (!reviewedBy || reviewedBy.deletedAt || !reviewedBy.username) return { account: null };
  return { account: { username: reviewedBy.username, image: reviewedBy.image } };
}

/**
 * What the developer-facing byline renders for `reviewer`: the named reviewer, the team (an
 * account that is gone), or nothing (an undecided entry, or a projection without a reviewer).
 */
export function decisionReviewerByline(
  reviewer: DecisionReviewer | null | undefined
): { kind: 'named'; username: string; image: string | null } | { kind: 'team' } | null {
  if (!reviewer) return null;
  const username = reviewer.account?.username?.trim();
  if (!username) return { kind: 'team' };
  return { kind: 'named', username, image: reviewer.account?.image ?? null };
}
