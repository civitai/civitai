import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from '../db';
import { describeEvidence, parseLinkEvidence } from './evidence';

export const LINK_REVIEW_STATUSES = ['Pending', 'Blocked', 'Cleared'] as const;
export type LinkReviewStatus = (typeof LINK_REVIEW_STATUSES)[number];

export const LINK_REVIEW_LIMIT = 100;

export type LinkReviewMember = {
  userId: number;
  username: string | null;
  createdAt: Date | null;
  banned: boolean;
  payoutBlockedAt: Date | null;
  payoutBlockReason: string | null;
};

export type LinkReview = {
  id: number;
  status: LinkReviewStatus;
  autoBlocked: boolean;
  buzzMoved: number;
  createdAt: Date;
  reviewedAt: Date | null;
  lines: string[];
  members: LinkReviewMember[];
};

export async function countPendingLinkReviews(): Promise<number> {
  const row = await dbRead
    .selectFrom('NewOrderLinkReview')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', '=', 'Pending')
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function getLinkReviews(status: LinkReviewStatus): Promise<LinkReview[]> {
  const reviews = await dbWrite
    .selectFrom('NewOrderLinkReview')
    .selectAll()
    .where('status', '=', status)
    .orderBy('buzzMoved', 'desc')
    .orderBy('id', 'desc')
    .limit(LINK_REVIEW_LIMIT)
    .execute();
  if (reviews.length === 0) return [];

  const ids = [...new Set(reviews.flatMap((r) => r.userIds))];
  const [users, players] = await Promise.all([
    dbWrite
      .selectFrom('User')
      .select(['id', 'username', 'createdAt', 'bannedAt'])
      .where('id', 'in', ids)
      .execute(),
    dbWrite
      .selectFrom('NewOrderPlayer')
      .select(['userId', 'payoutBlockedAt', 'payoutBlockReason'])
      .where('userId', 'in', ids)
      .execute(),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const playerById = new Map(players.map((p) => [p.userId, p]));

  const nameOf = (id: number) => userById.get(id)?.username ?? `#${id}`;

  return reviews.map((r) => ({
    id: r.id,
    status: r.status as LinkReviewStatus,
    autoBlocked: r.autoBlocked,
    buzzMoved: r.buzzMoved,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt,
    lines: describeEvidence(parseLinkEvidence(r.evidence), nameOf),
    members: r.userIds.map((userId) => {
      const user = userById.get(userId);
      const player = playerById.get(userId);
      return {
        userId,
        username: user?.username ?? null,
        createdAt: user?.createdAt ?? null,
        banned: user?.bannedAt != null,
        payoutBlockedAt: player?.payoutBlockedAt ?? null,
        payoutBlockReason: player?.payoutBlockReason ?? null,
      };
    }),
  }));
}

export type ReviewOutcome = { ok: true } | { ok: false; error: string };

const GONE = 'This item has already been decided. Reload the page.';
const BLOCK_REASON = 'Linked accounts: payouts held by moderator';

export async function blockLinkReview(id: number, moderatorId: number): Promise<ReviewOutcome> {
  return dbWrite.transaction().execute(async (tx) => {
    const review = await tx
      .updateTable('NewOrderLinkReview')
      .set({ status: 'Blocked', reviewedBy: moderatorId, reviewedAt: new Date() })
      .where('id', '=', id)
      .where('status', '=', 'Pending')
      .returning('userIds')
      .executeTakeFirst();
    if (!review) return { ok: false, error: GONE };

    await tx
      .updateTable('NewOrderPlayer')
      .set({
        payoutBlockedAt: new Date(),
        payoutBlockReason: BLOCK_REASON,
        payoutBlockedBy: moderatorId,
      })
      .where('userId', 'in', review.userIds)
      .where('payoutBlockedAt', 'is', null)
      .execute();
    return { ok: true };
  });
}

export async function clearLinkReview(id: number, moderatorId: number): Promise<ReviewOutcome> {
  return dbWrite.transaction().execute(async (tx) => {
    const current = await tx
      .selectFrom('NewOrderLinkReview')
      .select(['userIds', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current || (current.status !== 'Pending' && current.status !== 'Blocked')) {
      return { ok: false, error: GONE };
    }

    // Lock the members first so two overlapping reviews cleared at once see each other's outcome.
    await tx
      .selectFrom('NewOrderPlayer')
      .select('userId')
      .where('userId', 'in', current.userIds)
      .orderBy('userId')
      .forUpdate()
      .execute();

    const review = await tx
      .updateTable('NewOrderLinkReview')
      .set({ status: 'Cleared', reviewedBy: moderatorId, reviewedAt: new Date() })
      .where('id', '=', id)
      .where('status', 'in', ['Pending', 'Blocked'])
      .returning(['userIds', 'status'])
      .executeTakeFirst();
    if (!review) return { ok: false, error: GONE };
    if (current.status !== 'Blocked') return { ok: true };

    // Payouts for judgments from the block day onward are paid by the next grant run; the grant job
    // pays each day 3 days late, so the first held day is two days before the block day.
    const heldFrom = sql<Date>`date_trunc('day', "payoutBlockedAt") - interval '2 days'`;
    await tx
      .updateTable('NewOrderPlayer')
      .set({
        payoutReleaseFrom: sql<Date>`LEAST(COALESCE("payoutReleaseFrom", ${heldFrom}), ${heldFrom})`,
        payoutBlockedAt: null,
        payoutBlockReason: null,
        payoutBlockedBy: null,
      })
      .where('userId', 'in', review.userIds)
      .where('payoutBlockedAt', 'is not', null)
      .where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM "NewOrderLinkReview" other
          WHERE other."status" = 'Blocked' AND other."id" <> ${id}
            AND "NewOrderPlayer"."userId" = ANY(other."userIds")
        )`
      )
      .execute();
    return { ok: true };
  });
}
