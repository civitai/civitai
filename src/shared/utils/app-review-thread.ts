/**
 * The reply thread on an app review decision: the rules that need no database, shared by the
 * service, the notification processors and the pages. Pure and dependency-free (the processors
 * are in the client graph).
 */

/** Message length bounds, after trimming. The DB CHECK is the same range. */
export const REVIEW_MESSAGE_BODY_MIN = 1;
export const REVIEW_MESSAGE_BODY_MAX = 2000;

/** A notification carries at most this much of the message. */
export const REVIEW_REPLY_EXCERPT_MAX = 200;

/** Newest messages a thread read returns; an older remainder is not shown. */
export const REVIEW_THREAD_MESSAGE_LIMIT = 200;

export type ReviewMessageAuthorRole = 'developer' | 'moderator';

/**
 * What a thread hangs on: an on-site version request (`pubreq_…`, `app_block_publish_requests`)
 * or a store-listing request (`alpr_…`, `app_listing_publish_requests`).
 */
export type ReviewThreadSubjectRef = { kind: 'version' | 'listing'; id: string };

const SUBJECT_ID = /^(pubreq|alpr)_[A-Za-z0-9]{1,60}$/;

/** The subject an id names, or `null` for anything that is not a request id. */
export function parseReviewSubjectId(raw: unknown): ReviewThreadSubjectRef | null {
  if (typeof raw !== 'string') return null;
  const match = SUBJECT_ID.exec(raw);
  if (!match) return null;
  return { kind: match[1] === 'pubreq' ? 'version' : 'listing', id: raw };
}

/** The trimmed body, or why it cannot be posted. */
export function normalizeReviewMessageBody(
  raw: string
): { ok: true; body: string } | { ok: false; reason: 'empty' | 'too-long' } {
  const body = raw.trim();
  if (body.length < REVIEW_MESSAGE_BODY_MIN) return { ok: false, reason: 'empty' };
  if (body.length > REVIEW_MESSAGE_BODY_MAX) return { ok: false, reason: 'too-long' };
  return { ok: true, body };
}

/** The reviewer of the request, as stored. `null` when nobody is recorded (automated, undecided). */
export type ReplyReviewer = {
  id: number;
  deletedAt: Date | string | null;
  bannedAt: Date | string | null;
  isModerator: boolean | null;
} | null;

export type ReplyRoute =
  /** A moderator's message: the developer side is notified. */
  | { to: 'developer' }
  /** A developer's message to the moderator who decided the request. */
  | { to: 'reviewer'; userId: number }
  /** A developer's message nobody individual can take: it waits in the moderator queue. */
  | { to: 'queue' };

/**
 * Who a new message goes to, decided from stored facts only. A developer's message goes to the
 * request's reviewer while that account exists, is not banned and is still a moderator; otherwise
 * (no reviewer recorded, an automated review, a gone or demoted account) to the moderator queue.
 */
export function routeReply({
  authorRole,
  reviewer,
  authorUserId,
}: {
  authorRole: ReviewMessageAuthorRole;
  reviewer: ReplyReviewer;
  /** The poster. A reviewer replying on their own app's submission cannot be the one told. */
  authorUserId?: number;
}): ReplyRoute {
  if (authorRole === 'moderator') return { to: 'developer' };
  if (!reviewer || reviewer.deletedAt || reviewer.bannedAt || reviewer.isModerator !== true) {
    return { to: 'queue' };
  }
  // Routed to themselves, nobody would hear it: the queue takes it instead.
  if (authorUserId != null && reviewer.id === authorUserId) return { to: 'queue' };
  return { to: 'reviewer', userId: reviewer.id };
}

/**
 * Which side of a thread the viewer is on, or `null` for a non-participant (who must not learn
 * the thread exists). The developer side wins: a moderator on their own app's submission writes
 * as its developer, so their reply goes to a reviewer and never reads as Civitai App Review.
 */
export function reviewThreadViewerRole({
  viewerUserId,
  viewerIsModerator,
  submittedByUserId,
  listingOwnerUserId,
}: {
  viewerUserId: number;
  viewerIsModerator: boolean;
  submittedByUserId: number;
  listingOwnerUserId: number | null | undefined;
}): ReviewMessageAuthorRole | null {
  if (viewerUserId === submittedByUserId || viewerUserId === listingOwnerUserId) {
    return 'developer';
  }
  return viewerIsModerator ? 'moderator' : null;
}

/** The developer side notified of a moderator's message: submitter and listing owner, once each. */
export function developerSideRecipients(
  submittedByUserId: number,
  listingOwnerUserId: number | null | undefined
): number[] {
  const ids = [submittedByUserId];
  if (typeof listingOwnerUserId === 'number' && listingOwnerUserId !== submittedByUserId) {
    ids.push(listingOwnerUserId);
  }
  return ids;
}

/** The message as one line of at most {@link REVIEW_REPLY_EXCERPT_MAX} characters. */
export function reviewReplyExcerpt(body: string | null | undefined): string {
  const line = typeof body === 'string' ? body.replace(/\s+/g, ' ').trim() : '';
  if (line.length <= REVIEW_REPLY_EXCERPT_MAX) return line;
  return `${line.slice(0, REVIEW_REPLY_EXCERPT_MAX - 1).trimEnd()}…`;
}

/** The developer's thread page. */
export function reviewThreadDeveloperUrl(subjectId: string): string {
  return `/apps/submissions/${encodeURIComponent(subjectId)}`;
}

/**
 * Where a moderator reads the thread: the review page's Conversation tab for a version request,
 * and the queue's Replies tab (which opens the thread inline) for a listing request, which has no
 * review page.
 */
export function reviewThreadModeratorUrl(subjectId: string): string {
  const ref = parseReviewSubjectId(subjectId);
  if (ref?.kind === 'version') {
    return `/apps/review/${encodeURIComponent(subjectId)}?tab=conversation`;
  }
  return `/apps/review?tab=replies&thread=${encodeURIComponent(subjectId)}`;
}

/** Whether the reply box may submit: something to send, within the limit, nothing in flight. */
export function canSubmitReviewReply(draft: string, pending: boolean): boolean {
  return !pending && normalizeReviewMessageBody(draft).ok;
}

/**
 * A request someone has decided (approved or rejected): the statuses the developer is offered
 * the conversation on, and the ones that carry a reviewer (`decisionReviewer`). One rule.
 */
export function isDecidedReviewStatus(status: string | null | undefined): boolean {
  return status === 'approved' || status === 'rejected';
}
