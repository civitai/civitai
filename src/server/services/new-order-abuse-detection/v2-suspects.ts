import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { dbRead } from '~/server/db/client';
import { ABUSE_SCAN_WINDOW_HOURS, type AbuseSuspect } from './report';

export type V2SuspectThresholds = {
  minTotalRatings: number;
  havingDominantPct: number;
  havingAvgPerMinute: number;
  smiteMaxUniqueRatings: number;
};

const V2_SUSPECT_LIMIT = 50;

type V2Row = {
  userId: number;
  totalRatings: number;
  uniqueRatings: number;
  dominantAnswer: string;
  dominantPct: number;
  avgPerMinute: number;
};

/**
 * The v1 scan's selection rule over Knights v2 rating votes. Acolytes cannot vote in v2, so there
 * is no rank filter. The `createdAt` range predicate stays on the base scan so the monthly
 * partitions prune. Counts are cast in SQL because Prisma returns `count()` as a bigint.
 */
export async function loadV2AbuseSuspects(t: V2SuspectThresholds): Promise<AbuseSuspect[]> {
  const rows = await dbRead.$queryRaw<V2Row[]>`
    WITH votes AS (
      SELECT "playerId", "answer", date_trunc('minute', "createdAt") AS minute
      FROM "KnightsVote"
      WHERE "questionKey" = ${KNIGHTS_NSFW_LEVEL_QUESTION}
        AND "createdAt" >= now() - (${ABUSE_SCAN_WINDOW_HOURS}::int * interval '1 hour')
    ),
    per_answer AS (
      SELECT "playerId", "answer", count(*) AS n FROM votes GROUP BY "playerId", "answer"
    ),
    dominant AS (
      SELECT DISTINCT ON ("playerId") "playerId", "answer", n
      FROM per_answer
      ORDER BY "playerId", n DESC, "answer"
    ),
    totals AS (
      SELECT "playerId",
        count(*) AS total,
        count(DISTINCT "answer") AS uniq,
        count(DISTINCT minute) AS minutes
      FROM votes
      GROUP BY "playerId"
    )
    SELECT
      t."playerId" AS "userId",
      t.total::int AS "totalRatings",
      t.uniq::int AS "uniqueRatings",
      d."answer" AS "dominantAnswer",
      (d.n * 100.0 / t.total)::float8 AS "dominantPct",
      (t.total::float8 / greatest(t.minutes, 1))::float8 AS "avgPerMinute"
    FROM totals t
    JOIN dominant d ON d."playerId" = t."playerId"
    WHERE t.total >= ${t.minTotalRatings}::int
      AND (
        t.uniq <= ${t.smiteMaxUniqueRatings}::int
        OR d.n * 100.0 / t.total >= ${t.havingDominantPct}::float8
        OR t.total::float8 / greatest(t.minutes, 1) > ${t.havingAvgPerMinute}::float8
      )
    ORDER BY t.total DESC, t."playerId"
    LIMIT ${V2_SUSPECT_LIMIT}::int
  `;
  return rows.map((r) => ({
    userId: Number(r.userId),
    totalRatings: Number(r.totalRatings),
    uniqueRatings: Number(r.uniqueRatings),
    dominantRating: Number(r.dominantAnswer),
    dominantPct: Number(r.dominantPct),
    avgPerMinute: Number(r.avgPerMinute),
    source: 'v2',
  }));
}
