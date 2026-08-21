import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
export { getSplitPoint, splitFrontPageQueue } from './front-page-timers';

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

/**
 * Retool's `ResearchRating`, over the unmodelled `research_ratings` table.
 *
 * Grouped by user id, NOT by username as Retool had it: deleted accounts carry a NULL username, so
 * grouping on the name alone folds every one of them into a single row — which rendered as one person
 * called "unknown" with 30× the top real rater's count.
 */
async function researchRaters(): Promise<RaterCount[]> {
  const { rows } = await sql<{ userId: number; username: string | null; count: string }>`
    SELECT rr."userId" AS "userId", u."username", COUNT(*) AS count
    FROM "research_ratings" rr
    JOIN "User" u ON u."id" = rr."userId"
    GROUP BY rr."userId", u."username"
    ORDER BY 3 DESC
    LIMIT 50
  `.execute(dbRead);
  return rows.map((r) => ({ username: r.username, userId: r.userId, count: Number(r.count) }));
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
