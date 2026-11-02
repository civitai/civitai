import { sql } from '@civitai/db/kysely';
import type { RatingReviewRow } from '../rating-reviews.service';
import { RATING_DISPUTE_ROWS } from '$lib/tickets/rating-disputes';
import { ReportStatus } from '$lib/rating-review';

export type TicketRatingDispute = {
  id: number;
  entityType: RatingReviewRow['entityType'];
  entityId: number;
  title: string | null;
  /** The entity's path on the site, when it still exists. */
  path: string | null;
  entityExists: boolean;
  status: string;
  currentLevel: number;
  suggestedLevel: number;
  appliedLevel: number | null;
  userComment: string | null;
  modComment: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
  /** The levels a moderator may apply, as the queue offers them. */
  levelOptions: number[];
  rulable: boolean;
};

export type TicketRatingDisputes =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | { status: 'ok'; userId: number; disputes: TicketRatingDispute[]; truncated: boolean };

export type RatingDisputeReads = {
  disputesOf: (userId: number, limit: number) => Promise<RatingReviewRow[]>;
};

// Imported when read, so loading the ticket detail module opens no database connection.
const liveReads: RatingDisputeReads = {
  // The queue's own row select, owner-filtered on the `userId` index; hydrated in one batch per type.
  disputesOf: async (userId, limit) => {
    const { hydrateRatingReviews, ratingReviewRowQuery } = await import(
      '../rating-reviews.service'
    );
    return hydrateRatingReviews(
      await ratingReviewRowQuery()
        .where('rr.userId', '=', userId)
        // Pending first, so the bounded read never drops one behind a run of decided disputes.
        .orderBy(sql`(rr."status" = 'Pending') desc`)
        .orderBy('rr.createdAt', 'desc')
        .orderBy('rr.id', 'desc')
        .limit(limit)
        .execute()
    );
  },
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The linked user's rating disputes, pending first then newest, bounded. */
export async function ratingDisputesSectionFor(
  ticket: { userId: number },
  reads: RatingDisputeReads = liveReads
): Promise<Extract<TicketRatingDisputes, { status: 'ok' }>> {
  const rows = await reads.disputesOf(ticket.userId, RATING_DISPUTE_ROWS + 1);
  return {
    status: 'ok',
    userId: ticket.userId,
    truncated: rows.length > RATING_DISPUTE_ROWS,
    disputes: rows.slice(0, RATING_DISPUTE_ROWS).map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      title: r.entity?.title ?? null,
      path: r.entity?.path ?? null,
      entityExists: r.entity !== null,
      status: r.status,
      currentLevel: r.currentLevel,
      suggestedLevel: r.suggestedLevel,
      appliedLevel: r.appliedLevel,
      userComment: r.userComment,
      modComment: r.modComment,
      createdAt: iso(r.createdAt),
      resolvedAt: iso(r.resolvedAt),
      levelOptions: r.levelOptions,
      rulable: r.status === ReportStatus.Pending,
    })),
  };
}
