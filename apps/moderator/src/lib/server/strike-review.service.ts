import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { toLiveStrike, type LiveStrike } from './user-lookup.service';

/** How many of the oldest flagged accounts the page lists at once. */
export const STRIKE_REVIEW_LIMIT = 100;

// One predicate for the badge, the page and the actions' subject check, so a row the badge counts is one
// the page shows and an action can reach.
//
// 🔴 Must stay equivalent to the predicate of the partial index `User_strikeReview_idx`, or the
// planner falls back to scanning every muted account. The pglite test plans it against the index.
//
// `muted` is here because a moderator's unmute does not clear the review flag; without it an unmuted
// account would stay in the queue with nothing left to decide.
const inQueue = sql<boolean>`(u."meta"->>'strikeFlaggedForReview')::boolean IS TRUE
  AND u."bannedAt" IS NULL
  AND u."deletedAt" IS NULL
  AND u."muted" = true`;

export async function countStrikeReview(db: typeof dbRead = dbRead): Promise<number> {
  const row = await db
    .selectFrom('User as u')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where(inQueue)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type StrikeReviewStrike = LiveStrike & {
  entityType: string | null;
  entityId: number | null;
  voidReason: string | null;
};

export type StrikeReviewRow = {
  userId: number;
  username: string | null;
  /** ISO timestamp the account was flagged, as the main app wrote it; null on a row flagged before
   *  the timestamp was recorded. */
  flaggedAt: string | null;
  mutedAt: Date | null;
  muteExpiresAt: Date | null;
  activePoints: number;
  strikes: StrikeReviewStrike[];
};

/** Read on the PRIMARY: it is what an action reloads, and on the replica the row the action just took
 *  out of the queue can still be there. */
export async function getStrikeReviewQueue(): Promise<{ rows: StrikeReviewRow[]; total: number }> {
  const [users, total] = await Promise.all([
    dbWrite
      .selectFrom('User as u')
      .select([
        'u.id as userId',
        'u.username',
        'u.mutedAt',
        'u.muteExpiresAt',
        // An ISO string, so text order is time order.
        sql<string | null>`u."meta"->>'strikeFlaggedAt'`.as('flaggedAt'),
      ])
      .where(inQueue)
      .orderBy(sql`u."meta"->>'strikeFlaggedAt'`, sql`asc nulls first`)
      .orderBy('u.id', 'asc')
      .limit(STRIKE_REVIEW_LIMIT)
      .execute(),
    countStrikeReview(dbWrite),
  ]);
  if (users.length === 0) return { rows: [], total };

  const strikes = await dbWrite
    .selectFrom('UserStrike as s')
    .leftJoin('User as issuer', 'issuer.id', 's.issuedBy')
    .select([
      's.id',
      's.userId',
      's.reason',
      's.description',
      's.points',
      's.status',
      's.createdAt',
      's.expiresAt',
      's.voidedAt',
      's.voidReason',
      's.issuedBy',
      's.entityType',
      's.entityId',
      'issuer.username as issuerUsername',
      's.internalNotes',
    ])
    .where(
      's.userId',
      'in',
      users.map((u) => u.userId)
    )
    .orderBy('s.createdAt', 'desc')
    .orderBy('s.id', 'desc')
    .execute();

  const byUser = new Map<number, StrikeReviewStrike[]>();
  for (const { userId, entityType, entityId, voidReason, ...row } of strikes) {
    const list = byUser.get(userId) ?? [];
    list.push({ ...toLiveStrike(row), entityType, entityId, voidReason });
    byUser.set(userId, list);
  }

  const now = Date.now();
  return {
    total,
    rows: users.map((u) => {
      const list = byUser.get(u.userId) ?? [];
      return {
        ...u,
        strikes: list,
        // The same rule as the main app's point total: Active, not voided, not yet expired.
        activePoints: list
          .filter(
            (s) =>
              s.status === 'Active' && s.voidedAt == null && new Date(s.expiresAt).getTime() > now
          )
          .reduce((sum, s) => sum + s.points, 0),
      };
    }),
  };
}

/**
 * Whether the account is in the queue right now, read on the PRIMARY: the actions resolve their subject
 * through this, and the replica can still show an account a moment-ago ban or unmute has taken out.
 */
export async function isInStrikeReview(userId: number): Promise<boolean> {
  const row = await dbWrite
    .selectFrom('User as u')
    .select('u.id')
    .where('u.id', '=', userId)
    .where(inQueue)
    .executeTakeFirst();
  return row != null;
}

/** The owner of an Active strike, or null; the void action is scoped to accounts in the queue. */
export async function activeStrikeOwner(strikeId: number): Promise<number | null> {
  const row = await dbWrite
    .selectFrom('UserStrike')
    .select('userId')
    .where('id', '=', strikeId)
    .where('status', '=', 'Active')
    .executeTakeFirst();
  return row?.userId ?? null;
}

/**
 * Records an unmute from this queue as the review's outcome. The main app's unmute leaves the flag, so
 * without this a later unrelated mute would bring the account back here as if newly flagged. Only once
 * the unmute has landed: a still-muted account keeps its flag.
 */
export async function clearStrikeReviewFlag(userId: number): Promise<void> {
  await dbWrite
    .updateTable('User')
    .set({
      meta: sql`jsonb_set(COALESCE("meta", '{}'::jsonb), '{strikeFlaggedForReview}', 'false'::jsonb)`,
    })
    .where('id', '=', userId)
    .where('muted', '=', false)
    .execute();
}
