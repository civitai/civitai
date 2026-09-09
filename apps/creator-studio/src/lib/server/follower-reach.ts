import { sql } from '@civitai/db/kysely';
import { getClickhouse } from '$lib/server/clickhouse';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import {
  REACH_WINDOWS,
  emptyWindows,
  mergeReachChunks,
  redactReach,
  type ReachRow,
  type FollowerReach,
} from '$lib/analytics/follower-reach';

// How much of a creator's follower list is still awake, and roughly where it is. Both answers come from
// `default.user_activity_rollup` (per-user last-seen + last-known country), which exists because neither is
// affordable against the source tables: see src/server/clickhouse/migrations/2026-09-04-user-activity-rollup.sql
// for the measurements and the engine choice.
//
// The follower scan is an index path only because prod carries
// `UserEngagement_type_targetUserId_idx (type, targetUserId) INCLUDE (userId)`, which is NOT in
// schema.full.prisma. Index-only scan, 145 ms for the platform's most-followed creator (53,304 followers),
// measured 2026-09-04.

// ClickHouse rejects a query over 256 KB (`max_query_size`), and the setting cannot be raised from inside the
// query it would apply to — the parser fails before it reaches the SETTINGS clause. At ~9 bytes per id, 53k ids
// is ~480 KB, so the list has to be split whatever else changes. 15,000 leaves room for the rest of the
// statement.
const ID_CHUNK = 15_000;

// 🔴 An empty or frozen table does not fail here. Every follower without a rollup row counts dormant — correct
// per-follower — so the page renders a confident "0.0% active" and a 100%-Unknown doughnut, and the six-hour
// cache below pins it there. Two ways in: DDL applied before the backfill ran, and the refresh job stopping
// quietly (it returns `{ skipped: 'clickhouse-unavailable' }` on missing credentials, which is a SUCCESS).
//
// Twelve hours, against a job that runs every 30 minutes with a 3-hour lookback: loose enough that a deploy or
// a few missed runs is not an alarm, tight enough to catch a stopped job long before the 30-day bucket
// visibly decays.
const MAX_ROLLUP_STALENESS_HOURS = 12;

async function assertRollupUsable() {
  const [row] = await getClickhouse().$query<{ rows: number | string; ageHours: number | string }>(
    `SELECT count() AS rows, dateDiff('hour', max(lastSeen), now()) AS ageHours
     FROM default.user_activity_rollup`
  );
  const rows = Number(row?.rows ?? 0);
  const ageHours = Number(row?.ageHours ?? Infinity);
  if (!rows || !Number.isFinite(ageHours) || ageHours > MAX_ROLLUP_STALENESS_HOURS) {
    // Thrown, not returned as a status: `createCache` writes nothing to Redis when the fetch rejects, so
    // the next request retries. A returned "unavailable" would be cached for the full six hours.
    throw new Error(
      `user_activity_rollup unusable (rows=${rows}, ageHours=${ageHours}) — backfill or refresh job stalled`
    );
  }
}

async function fetchFollowerIds(userId: number): Promise<number[]> {
  const result = await sql<{ userId: number }>`
    SELECT "userId" FROM "UserEngagement"
    WHERE "targetUserId" = ${userId} AND "type" = 'Follow'
  `.execute(dbRead);
  return result.rows.map((r) => Number(r.userId));
}

// ClickHouse returns UInt64 counts as strings, and one `a<days>` column per reach window.
type ChunkRow = { country: string; followers: number | string } & Record<string, number | string>;

// One row per country, already bucketed. The inner GROUP BY is required, not stylistic: rows in an
// AggregatingMergeTree are partial states until a background merge, so one user can have several, and reading
// `country` without `argMaxMerge` returns a state blob rather than a country.
function chunkSql(ids: number[]) {
  const windows = REACH_WINDOWS.map(
    (d) => `countIf(lastSeen > now() - INTERVAL ${d} DAY) AS a${d}`
  ).join(', ');
  return `
    SELECT country, count() AS followers, ${windows}
    FROM (
      SELECT userId, max(lastSeen) AS lastSeen, argMaxMerge(country) AS country
      FROM default.user_activity_rollup
      WHERE userId IN (${ids.join(',')})
      GROUP BY userId
    )
    GROUP BY country
  `;
}

// Hardcoding `a30/a60/a100` here would type-check against a fourth window while silently dropping it, and the
// page would render the missing one as a confident 0.0%.
function toReachRow(row: ChunkRow): ReachRow {
  const active = emptyWindows();
  for (const d of REACH_WINDOWS) active[d] = Number(row[`a${d}`] ?? 0);
  return { country: row.country, followers: Number(row.followers), active };
}

async function fetchFollowerReach(userId: number): Promise<FollowerReach> {
  await assertRollupUsable();

  const ids = await fetchFollowerIds(userId);
  if (!ids.length) return redactReach(mergeReachChunks([], 0));

  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));

  const clickhouse = getClickhouse();
  const results = await Promise.all(
    chunks.map((chunk) => clickhouse.$query<ChunkRow>(chunkSql(chunk)))
  );

  return redactReach(
    mergeReachChunks(
      results.map((rows) => rows.map(toReachRow)),
      ids.length
    )
  );
}

// 6h: every figure is a 30/60/100-day count, so none can move visibly inside a day, and a shorter TTL would
// just re-run the Postgres follower scan for an unchanged answer.
export const getFollowerReach = createCache({
  name: 'analytics:follower-reach:v1',
  fetch: ({ userId }: { userId: number }) => fetchFollowerReach(userId),
  ttlSeconds: 6 * 60 * 60,
}).get;
