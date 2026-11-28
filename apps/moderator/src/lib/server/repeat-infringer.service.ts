import { sql } from '@civitai/db/kysely';
import { dbWrite } from './db';

/** Repeat-infringer policy: this many copyright removal events inside the window send the
 *  account to a moderator's review. */
export const REPEAT_INFRINGER_THRESHOLD = 3;
export const REPEAT_INFRINGER_WINDOW_MONTHS = 12;
export const REPEAT_INFRINGER_LIMIT = 100;

// A removal event is a Copyright strike that was not voided: a void reverses the removal (a
// counter-notice restore), so it is not an event. Expired rows count, including the back-recorded ones.
// The partial index "UserStrike_copyright_user_created_idx" covers `reason = 'Copyright'`.
const events = sql`
  SELECT s."userId", count(*)::int AS "eventCount", max(s."createdAt") AS "lastEventAt"
  FROM "UserStrike" s
  WHERE s.reason = 'Copyright'
    AND s.status::text <> 'Voided'
    AND s."voidedAt" IS NULL
    AND s."createdAt" > now() - make_interval(months => ${REPEAT_INFRINGER_WINDOW_MONTHS})
  GROUP BY s."userId"
  HAVING count(*) >= ${REPEAT_INFRINGER_THRESHOLD}`;

// Queued until a moderator marks it reviewed; a new event after that review brings it back.
// `reviewedAt` is compared as fixed-width ISO text, never cast: one malformed value must not fail the
// whole queue and the sidebar count. Anything not in toISOString() form reads as unreviewed.
const reviewedAt = sql`u."meta"->'repeatInfringerReview'->>'reviewedAt'`;
const unreviewed = sql`(${reviewedAt} IS NULL
  OR ${reviewedAt} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  OR ${reviewedAt} < to_char(e."lastEventAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  AND u."bannedAt" IS NULL
  AND u."deletedAt" IS NULL`;

export type RepeatInfringerEvent = {
  id: number;
  createdAt: Date;
  status: string;
  points: number;
  description: string;
  internalNotes: string | null;
};

export type RepeatInfringerRow = {
  userId: number;
  username: string | null;
  eventCount: number;
  lastEventAt: Date;
  reviewedAt: string | null;
  events: RepeatInfringerEvent[];
};

export async function countRepeatInfringerReview(db = dbWrite): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM (${events}) e JOIN "User" u ON u.id = e."userId"
    WHERE ${unreviewed}`.execute(db);
  return rows[0]?.count ?? 0;
}

/** Read on the PRIMARY, like the strike review queue: it is what the Reviewed action reloads. */
export async function getRepeatInfringerQueue(): Promise<{
  rows: RepeatInfringerRow[];
  total: number;
}> {
  const [{ rows: users }, total] = await Promise.all([
    sql<Omit<RepeatInfringerRow, 'events'>>`
      SELECT e."userId", u.username, e."eventCount", e."lastEventAt",
             u."meta"->'repeatInfringerReview'->>'reviewedAt' AS "reviewedAt"
      FROM (${events}) e JOIN "User" u ON u.id = e."userId"
      WHERE ${unreviewed}
      ORDER BY e."lastEventAt" ASC, e."userId" ASC
      LIMIT ${REPEAT_INFRINGER_LIMIT}`.execute(dbWrite),
    countRepeatInfringerReview(dbWrite),
  ]);
  if (users.length === 0) return { rows: [], total };

  const strikes = await dbWrite
    .selectFrom('UserStrike as s')
    .select([
      's.id',
      's.userId',
      's.createdAt',
      's.status',
      's.points',
      's.description',
      's.internalNotes',
    ])
    .where('s.reason', '=', 'Copyright')
    // The same window the count uses, so the list shows what the badge counts.
    .where(
      sql<boolean>`s."createdAt" > now() - make_interval(months => ${REPEAT_INFRINGER_WINDOW_MONTHS})`
    )
    .where(
      's.userId',
      'in',
      users.map((u) => u.userId)
    )
    .orderBy('s.createdAt', 'desc')
    .execute();

  const byUser = new Map<number, RepeatInfringerEvent[]>();
  for (const { userId, ...event } of strikes) {
    const list = byUser.get(userId) ?? [];
    list.push({ ...event, status: String(event.status) });
    byUser.set(userId, list);
  }
  return { total, rows: users.map((u) => ({ ...u, events: byUser.get(u.userId) ?? [] })) };
}

/** Whether the account is in the queue right now; the Reviewed action resolves its subject through it. */
export async function isInRepeatInfringerReview(userId: number): Promise<boolean> {
  const { rows } = await sql<{ one: number }>`
    SELECT 1 AS one FROM (${events}) e JOIN "User" u ON u.id = e."userId"
    WHERE e."userId" = ${userId} AND ${unreviewed}`.execute(dbWrite);
  return rows.length > 0;
}

/** Records the review on the account. Only this clears it from the queue: nothing in strike escalation
 *  reads or writes the key. The moderator's note goes to user notes, never into `meta`. */
export async function markRepeatInfringerReviewed(userId: number, moderatorId: number) {
  const review = JSON.stringify({ reviewedAt: new Date().toISOString(), reviewedBy: moderatorId });
  await dbWrite
    .updateTable('User')
    .set({
      meta: sql`jsonb_set(COALESCE("meta", '{}'::jsonb), '{repeatInfringerReview}', ${review}::jsonb)`,
    })
    .where('id', '=', userId)
    .execute();
}
