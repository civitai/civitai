import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getModeratorDb } from './moderator-db';

// Retool's Graphs tab (`button43` "Load Graphs" → four queries at once) plus the Split control that
// sat beside it. Its own route rather than the dashboard, because Retool put it behind an explicit
// button for a reason: these are unindexed aggregates and nobody wants them on every page load.

export type HourlyPoint = { hour: Date; count: number };

/** Retool's `HourlyImages` / `HourlyModels`: upload rate, which is how a flood is spotted. */
async function hourly(table: 'Image' | 'Model', hours: number): Promise<HourlyPoint[]> {
  const { rows } = await sql<{ hour: Date; count: string }>`
    SELECT date_trunc('hour', "createdAt") AS hour, COUNT(*) AS count
    FROM ${sql.table(table)}
    WHERE "createdAt" > NOW() - (${hours} * INTERVAL '1 hour')
    GROUP BY 1
    ORDER BY 1 ASC
  `.execute(dbRead);
  // Ascending, unlike Retool's DESC: these are read as a time series left to right.
  return rows.map((r) => ({ hour: r.hour, count: Number(r.count) }));
}

export type RaterCount = { username: string | null; userId: number | null; count: number };

/**
 * Retool's `RRatingStats`: who has been setting NSFW levels. Bounded, where Retool was not — this is
 * an unindexed GROUP BY over `ModActivity`, and "who is working the rating queue" is a question about
 * recent throughput, not about all time. The window is stated on the page rather than assumed.
 */
async function ratersByModActivity(days: number): Promise<RaterCount[]> {
  const rows = await dbRead
    .selectFrom('ModActivity as ma')
    .innerJoin('User as u', 'u.id', 'ma.userId')
    .select((eb) => ['u.username', 'u.id as userId', eb.fn.countAll<string>().as('count')])
    .where('ma.activity', '=', 'setNsfwLevel')
    .where('ma.createdAt', '>', sql<Date>`NOW() - (${days} * INTERVAL '1 day')`)
    .groupBy(['u.username', 'u.id'])
    .orderBy('count', 'desc')
    .limit(50)
    .execute();
  return rows.map((r) => ({ username: r.username, userId: r.userId, count: Number(r.count) }));
}

/** Retool's `ResearchRating`, over the unmodelled `research_ratings` table. */
async function researchRaters(): Promise<RaterCount[]> {
  const { rows } = await sql<{ username: string | null; count: string }>`
    SELECT u."username", COUNT(*) AS count
    FROM "research_ratings" rr
    JOIN "User" u ON u."id" = rr."userId"
    GROUP BY u."username"
    ORDER BY 2 DESC
    LIMIT 50
  `.execute(dbRead);
  return rows.map((r) => ({ username: r.username, userId: null, count: Number(r.count) }));
}

export type QueueStats = {
  images: HourlyPoint[];
  models: HourlyPoint[];
  raters: RaterCount[];
  researchRaters: RaterCount[];
  raterDays: number;
  hours: number;
};

export async function getQueueStats({ hours = 200, raterDays = 30 } = {}): Promise<QueueStats> {
  const [images, models, raters, research] = await Promise.all([
    hourly('Image', hours),
    hourly('Model', hours),
    ratersByModActivity(raterDays),
    // `research_ratings` is not in the Prisma schema and may not exist in every environment.
    researchRaters().catch(() => []),
  ]);
  return { images, models, raters, researchRaters: research, raterDays, hours };
}

// THE SPLIT CONTROL (Retool's `GetSplitQueue` / `SplitCurrent` / `SplitCatchup`).
//
// When the front-page rating sweep falls behind, it is forked: one stream keeps working the newest
// images while a catch-up stream works the backlog. The fork point is a row in each timers table.
//
// `button69`'s tooltip was **"Only do this if it's 4 or more hours behind"** — an operating rule that
// exists in no query, so it is stated on the page. Splitting a queue that is keeping up just creates a
// second stream with nothing in it.
const SPLIT_USERNAME = 'splitQueue';

/** Retool's `GetSplitQueue`: where the queue was last forked. */
export async function getSplitPoint(): Promise<Date | null> {
  const row = await getModeratorDb()
    .selectFrom('FrontPageTimers')
    .select('lastCheckedAt')
    .where('username', '=', SPLIT_USERNAME)
    .orderBy('lastCheckedAt', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.lastCheckedAt ? new Date(row.lastCheckedAt as unknown as string) : null;
}

/**
 * Retool wrote the SAME row into both tables: the current stream resumes from the fork point and the
 * catch-up stream starts there too. The three-hour offset is Retool's — the fork is placed slightly in
 * the past so images uploaded around the split are picked up by one stream rather than missed by both.
 */
// No attribution: `username` is the sentinel that identifies the row as the fork point, so the table
// has nowhere to record who pressed it. The ModActivity row the caller writes is the audit trail.
export async function splitFrontPageQueue(): Promise<{ at: Date }> {
  const at = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const row = {
    username: SPLIT_USERNAME,
    nsfw: '1',
    lastCheckedAt: at,
    buttonPressedTime: new Date(),
  };

  const db = getModeratorDb();
  // Both or neither: one table forked and the other not is a queue that silently skips a window.
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('FrontPageTimers').values(row).execute();
    await trx.insertInto('FrontPageTimers_catchup').values(row).execute();
  });

  return { at };
}
