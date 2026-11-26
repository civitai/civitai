import { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  decisionReviewer,
  type DecisionReviewer,
} from '~/server/notifications/app-review-attribution';
import type { PostReviewMessageInput } from '~/server/schema/blocks/app-review-thread.schema';
import { reviewUserChipSelect } from '~/server/selectors/review-user-chip.selector';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { resolveListingAccess } from '~/server/services/blocks/app-access.service';
import { notifyAppReviewReply } from '~/server/services/blocks/app-review-thread-notify';
import {
  developerSideRecipients,
  normalizeReviewMessageBody,
  parseReviewSubjectId,
  REVIEW_MESSAGE_BODY_MAX,
  REVIEW_THREAD_MESSAGE_LIMIT,
  reviewReplyExcerpt,
  reviewThreadViewerRole,
  routeReply,
  type ReplyRoute,
  type ReviewMessageAuthorRole,
  type ReviewThreadSubjectRef,
} from '~/shared/utils/app-review-thread';
import { appDisplayName } from '~/shared/utils/app-display-name';

/**
 * THE REPLY THREAD ON AN APP REVIEW DECISION (`app_review_messages`).
 *
 * A conversation on one publish request between its developer side (the submitter, plus the
 * listing's owner for a store-listing request) and moderators. Nobody else may read or post: a
 * non-participant gets NOT_FOUND, the same answer as a missing request, so a request id says
 * nothing about whether the request exists.
 *
 * A developer's message goes to the moderator who decided the request while that account is
 * live and still a moderator, else to the moderator queue (no individual notification, nobody
 * paged); a moderator's message goes to the developer side (`routeReply`).
 *
 * Every caller is behind the `appReviewReplies` flag (the router's procedures), so nothing here
 * touches the table while it is off.
 */

/** Typed failures. Duck-typed by the router's `mapOffsiteError` via `name`. */
export type AppReviewThreadErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_TEXT'
  | 'BLOCKED_LINK'
  | 'BLOCKED_CONTENT';

export class AppReviewThreadError extends Error {
  readonly code: AppReviewThreadErrorCode;
  constructor(code: AppReviewThreadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppReviewThreadError';
    this.code = code;
  }
}

/** Who is asking. `isModerator` is the session's moderator right (`actsAsModerator`). */
export type ReviewThreadViewer = { userId: number; isModerator: boolean };

/** One request, as the thread needs it. Server-side only: it carries user ids. */
type ReviewThreadSubjectRow = {
  ref: ReviewThreadSubjectRef;
  slug: string;
  name: string;
  version: string | null;
  status: string;
  rejectionReason: string | null;
  approvalNotes: string | null;
  submittedByUserId: number;
  reviewedByUserId: number | null;
  /** The listing's current owner, for a store-listing request with a listing. */
  listingOwnerUserId: number | null;
  reviewer: DecisionReviewer | null;
};

async function loadSubject(ref: ReviewThreadSubjectRef): Promise<ReviewThreadSubjectRow | null> {
  if (ref.kind === 'version') {
    const row = await dbRead.appBlockPublishRequest.findUnique({
      where: { id: ref.id },
      select: {
        slug: true,
        version: true,
        manifest: true,
        status: true,
        rejectionReason: true,
        approvalNotes: true,
        submittedByUserId: true,
        reviewedByUserId: true,
        reviewedBy: { select: reviewUserChipSelect },
      },
    });
    if (!row) return null;
    return {
      ref,
      slug: row.slug,
      name: appDisplayName(row.manifest, row.slug),
      version: row.version,
      status: row.status,
      rejectionReason: row.rejectionReason,
      approvalNotes: row.approvalNotes,
      submittedByUserId: row.submittedByUserId,
      reviewedByUserId: row.reviewedByUserId,
      listingOwnerUserId: null,
      reviewer: decisionReviewer(row.status, row.reviewedBy),
    };
  }

  const row = await dbRead.appListingPublishRequest.findUnique({
    where: { id: ref.id },
    select: {
      slug: true,
      status: true,
      rejectionReason: true,
      approvalNotes: true,
      submittedByUserId: true,
      reviewedByUserId: true,
      appListingId: true,
      appListing: { select: { name: true } },
      reviewedBy: { select: reviewUserChipSelect },
    },
  });
  if (!row) return null;
  // The canonical owner, not the `appListing.userId` copy: for an on-site listing that column
  // is denormalized and can name a former owner (see `resolveListingAccess`).
  let listingOwnerUserId: number | null = null;
  if (row.appListingId) {
    listingOwnerUserId = (await resolveListingAccess(row.appListingId, null))?.ownerUserId ?? null;
  }
  return {
    ref,
    slug: row.slug,
    name: row.appListing?.name?.trim() || row.slug,
    version: null,
    status: row.status,
    rejectionReason: row.rejectionReason,
    approvalNotes: row.approvalNotes,
    submittedByUserId: row.submittedByUserId,
    reviewedByUserId: row.reviewedByUserId,
    listingOwnerUserId,
    reviewer: decisionReviewer(row.status, row.reviewedBy),
  };
}

/** The subject and the viewer's side of it, or NOT_FOUND for a missing one or a non-participant. */
async function resolveParticipant(subjectId: string, viewer: ReviewThreadViewer) {
  const ref = parseReviewSubjectId(subjectId);
  const subject = ref ? await loadSubject(ref) : null;
  const role = subject
    ? reviewThreadViewerRole({
        viewerUserId: viewer.userId,
        viewerIsModerator: viewer.isModerator,
        submittedByUserId: subject.submittedByUserId,
        listingOwnerUserId: subject.listingOwnerUserId,
      })
    : null;
  if (!subject || !role) throw new AppReviewThreadError('NOT_FOUND', 'Submission not found.');
  return { subject, role };
}

function threadWhere(ref: ReviewThreadSubjectRef): Prisma.AppReviewMessageWhereInput {
  return ref.kind === 'version'
    ? { publishRequestId: ref.id }
    : { listingPublishRequestId: ref.id };
}

/** The header the developer's thread page shows: no user ids, the reviewer as a name chip. */
export async function getReviewThreadSubject(opts: {
  subjectId: string;
  viewer: ReviewThreadViewer;
}) {
  const { subject, role } = await resolveParticipant(opts.subjectId, opts.viewer);
  return {
    id: subject.ref.id,
    kind: subject.ref.kind,
    slug: subject.slug,
    name: subject.name,
    version: subject.version,
    status: subject.status,
    rejectionReason: subject.rejectionReason,
    approvalNotes: subject.approvalNotes,
    reviewer: subject.reviewer,
    viewerRole: role,
  };
}

export type ReviewThreadMessage = {
  id: number;
  body: string;
  createdAt: Date;
  authorRole: ReviewMessageAuthorRole;
  /** Name and avatar only; `null` when the account row is gone. */
  author: { username: string | null; image: string | null; deletedAt: Date | null } | null;
};

/** The thread, oldest first: the newest {@link REVIEW_THREAD_MESSAGE_LIMIT} messages. */
export async function listReviewMessages(opts: {
  subjectId: string;
  viewer: ReviewThreadViewer;
}): Promise<ReviewThreadMessage[]> {
  const { subject } = await resolveParticipant(opts.subjectId, opts.viewer);
  const rows = await dbRead.appReviewMessage.findMany({
    where: threadWhere(subject.ref),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: REVIEW_THREAD_MESSAGE_LIMIT,
    select: {
      id: true,
      body: true,
      createdAt: true,
      authorRole: true,
      author: { select: reviewUserChipSelect },
    },
  });
  return rows.reverse().map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.createdAt,
    authorRole: row.authorRole === 'moderator' ? 'moderator' : 'developer',
    author: row.author
      ? { username: row.author.username, image: row.author.image, deletedAt: row.author.deletedAt }
      : null,
  }));
}

/**
 * Post one message, then notify the other side best-effort. The message is stored first: a
 * notifications outage costs the notification, never the message.
 */
export async function postReviewMessage(opts: {
  input: PostReviewMessageInput;
  viewer: ReviewThreadViewer;
}): Promise<{ id: number; routedTo: ReplyRoute['to'] }> {
  const { input, viewer } = opts;
  const { subject, role } = await resolveParticipant(input.subjectId, viewer);

  // Re-checked below the schema, so a second caller cannot skip the bounds.
  const normalized = normalizeReviewMessageBody(input.body);
  if (!normalized.ok) {
    throw new AppReviewThreadError(
      'INVALID_TEXT',
      `A reply must be between 1 and ${REVIEW_MESSAGE_BODY_MAX} characters.`
    );
  }
  const body = normalized.body;

  // Only a real block maps to a typed refusal: `onBlocked` is called for a blocklist hit alone,
  // so a Redis or DB failure inside the filter propagates as the fault it is (INTERNAL at the
  // router, logged) and is never reported to the writer as a blocked link.
  await throwOnBlockedUserContent(body, {
    isModerator: role === 'moderator',
    surface: 'app-review-message',
    userId: viewer.userId,
    onBlocked: (kind) => {
      throw kind === 'link'
        ? new AppReviewThreadError('BLOCKED_LINK', 'The reply links to a site that is not allowed.')
        : new AppReviewThreadError(
            'BLOCKED_CONTENT',
            'The reply was blocked by the content filter.'
          );
    },
  });

  const reviewer =
    role === 'developer' && subject.reviewedByUserId != null
      ? await dbRead.user.findUnique({
          where: { id: subject.reviewedByUserId },
          select: { id: true, deletedAt: true, bannedAt: true, isModerator: true },
        })
      : null;
  const route = routeReply({ authorRole: role, reviewer, authorUserId: viewer.userId });

  const message = await dbWrite.appReviewMessage.create({
    data: {
      ...(subject.ref.kind === 'version'
        ? { publishRequestId: subject.ref.id }
        : { listingPublishRequestId: subject.ref.id }),
      authorUserId: viewer.userId,
      authorRole: role,
      body,
      recipientUserId: route.to === 'reviewer' ? route.userId : null,
    },
    select: { id: true },
  });

  try {
    const details = {
      subjectId: subject.ref.id,
      slug: subject.slug,
      name: subject.name,
      excerpt: reviewReplyExcerpt(body),
    };
    const key = `app-review-reply:${message.id}`;
    // The author is never told about their own message.
    if (route.to === 'reviewer' && route.userId !== viewer.userId) {
      await notifyAppReviewReply({
        type: 'app-review-reply-to-moderator',
        userIds: [route.userId],
        key,
        details,
      });
    } else if (route.to === 'developer') {
      await notifyAppReviewReply({
        type: 'app-review-reply-to-developer',
        userIds: developerSideRecipients(
          subject.submittedByUserId,
          subject.listingOwnerUserId
        ).filter((id) => id !== viewer.userId),
        key,
        details: { ...details, authorUserId: viewer.userId },
      });
    }
    // `queue`: no individual notification. The queue's Replies tab and its count show it.
  } catch (err) {
    logToAxiom({
      type: 'warning',
      name: 'app-review-reply-notify-failed',
      message: err instanceof Error ? err.message : String(err),
      payload: { messageId: message.id, subjectId: subject.ref.id, route: route.to },
    });
  }

  return { id: message.id, routedTo: route.to };
}

/**
 * The latest message of every thread whose latest message is a developer's, oldest first.
 * `routedToQueue`: the developer's message went to the queue rather than to a reviewer.
 */
const awaitingModeratorSql = Prisma.sql`
  SELECT DISTINCT ON (COALESCE(m.publish_request_id, m.listing_publish_request_id))
    COALESCE(m.publish_request_id, m.listing_publish_request_id) AS "subjectId",
    m.author_role AS "authorRole",
    m.recipient_user_id IS NULL AS "routedToQueue",
    m.body AS "body",
    m.created_at AS "createdAt"
  FROM app_review_messages m
  ORDER BY COALESCE(m.publish_request_id, m.listing_publish_request_id), m.created_at DESC, m.id DESC
`;

/** Moderators: threads waiting on the queue (latest message a developer's, routed to no one). */
export async function countRepliesAwaitingQueue(): Promise<number> {
  const [row] = await dbRead.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM (${awaitingModeratorSql}) latest
    WHERE latest."authorRole" = 'developer' AND latest."routedToQueue"
  `;
  return row?.count ?? 0;
}

export const REPLIES_AWAITING_LIMIT = 100;

export type ReplyAwaitingModerator = {
  subjectId: string;
  kind: 'version' | 'listing';
  slug: string;
  routedToQueue: boolean;
  excerpt: string;
  lastMessageAt: Date;
};

/** Moderators: every thread whose latest message is a developer's, oldest first. */
export async function listRepliesAwaitingModerator(): Promise<ReplyAwaitingModerator[]> {
  const rows = await dbRead.$queryRaw<
    {
      subjectId: string;
      routedToQueue: boolean;
      body: string;
      createdAt: Date;
      slug: string | null;
    }[]
  >`
    SELECT latest."subjectId", latest."routedToQueue", latest."body", latest."createdAt",
      COALESCE(b.slug, l.slug) AS slug
    FROM (${awaitingModeratorSql}) latest
    LEFT JOIN app_block_publish_requests b ON b.id = latest."subjectId"
    LEFT JOIN app_listing_publish_requests l ON l.id = latest."subjectId"
    WHERE latest."authorRole" = 'developer'
    ORDER BY latest."createdAt" ASC
    LIMIT ${REPLIES_AWAITING_LIMIT}
  `;
  return rows.map((row) => ({
    subjectId: row.subjectId,
    kind: parseReviewSubjectId(row.subjectId)?.kind ?? 'version',
    slug: row.slug ?? row.subjectId,
    routedToQueue: row.routedToQueue,
    excerpt: reviewReplyExcerpt(row.body),
    lastMessageAt: row.createdAt,
  }));
}
