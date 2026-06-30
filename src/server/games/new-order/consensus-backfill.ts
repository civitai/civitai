import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { allJudgmentsCounter, correctJudgmentsCounter, fervorCounter } from '~/server/games/new-order/utils';

const DEFAULT_START = '2026-06-23 00:00:00';

export type DecisionClass = 'same_level' | 'up_rate' | 'down_1lvl' | 'down_gt1' | 'unknown_orig';

export type Candidate = {
  imageId: number; domRating: number; voters: number; topCount: number; decision: DecisionClass;
};

export function classifyDecision(domRating: number, origLevel: number | null): DecisionClass {
  if (!origLevel || origLevel <= 0) return 'unknown_orig';
  if (domRating === origLevel) return 'same_level';
  if (domRating > origLevel) return 'up_rate';
  const distance = Math.abs(Math.log2(domRating) - Math.log2(origLevel));
  return distance <= 1 ? 'down_1lvl' : 'down_gt1';
}

export async function getConsensusCandidates(opts: {
  startDate?: string; minAgreement?: number; staleHours?: number;
} = {}): Promise<Candidate[]> {
  if (!clickhouse) throw new Error('clickhouse not configured');
  const startDate = opts.startDate ?? DEFAULT_START;
  if (!/^\d{4}-\d{2}-\d{2}/.test(startDate)) throw new Error(`invalid startDate: ${startDate}`);
  const minAgreement = opts.minAgreement ?? 0.6;
  const staleHours = opts.staleHours ?? 12;

  const rows = await clickhouse.$query<{
    imageId: number; voters: number; topCount: number; domRating: number; origLevel: number;
  }>`
    WITH latest AS (
      -- GROUP BY imageId,userId + argMax(.,createdAt) is served by the by_imageId
      -- projection (no FINAL full scan); one row per voter = the latest state.
      SELECT imageId, userId,
             argMax(rating, createdAt) AS rating,
             argMax(status, createdAt) AS status,
             argMax(originalLevel, createdAt) AS originalLevel,
             argMax(rank, createdAt) AS rank,
             max(createdAt) AS lastCreatedAt
      FROM knights_new_order_image_rating
      GROUP BY imageId, userId
    ),
    img AS (
      SELECT imageId, rating, status, originalLevel, lastCreatedAt
      FROM latest
      WHERE rank = 'Knight'
        AND status IN ('Pending','Inconclusive')
        AND lastCreatedAt >= '${startDate}'
    ),
    arr AS (
      SELECT imageId,
             count() AS voters,
             groupArray(rating) AS ratings,
             minIf(originalLevel, originalLevel > 0) AS origLevel,
             countIf(status='Pending') AS penCount,
             max(lastCreatedAt) AS lastVote
      FROM img GROUP BY imageId
    ),
    scored AS (
      SELECT imageId, voters, origLevel, penCount, lastVote,
             arrayMap(r -> arrayCount(x -> x = r, ratings), arrayDistinct(ratings)) AS counts,
             arrayDistinct(ratings) AS vals
      FROM arr
    )
    SELECT imageId,
           voters,
           arrayMax(counts) AS topCount,
           vals[indexOf(counts, arrayMax(counts))] AS domRating,
           origLevel
    FROM scored
    WHERE voters >= 4
      AND arrayMax(counts) / voters >= ${minAgreement}
      AND (penCount = 0 OR lastVote <= now() - INTERVAL ${staleHours} HOUR)
  `;

  return rows.map((r) => ({
    imageId: r.imageId,
    domRating: r.domRating,
    voters: r.voters,
    topCount: r.topCount,
    decision: classifyDecision(r.domRating, r.origLevel),
  }));
}

export async function restampBatch(
  pairs: { imageId: number; domRating: number }[],
  stampISO: string
): Promise<void> {
  if (!clickhouse) throw new Error('clickhouse not configured');
  if (pairs.length === 0) return;
  const ids = pairs.map((p) => p.imageId).join(',');
  const rats = pairs.map((p) => p.domRating).join(',');
  // arrayElement([rats], indexOf([ids], imageId)) -> this image's consensus rating.
  // GROUP BY imageId,userId + argMax(.,createdAt) WHERE imageId IN is served by the
  // by_imageId projection (~7 granules vs a 3958-granule FINAL scan); the argMax dedup
  // is the schema's canonical latest row (same pattern as updatePendingImageRatings).
  await clickhouse.$exec`
    INSERT INTO knights_new_order_image_rating
    WITH latest AS (
      SELECT
        imageId,
        userId,
        argMax(rating, createdAt) AS rating,
        argMax(damnedReason, createdAt) AS damnedReason,
        argMax(status, createdAt) AS status,
        argMax(grantedExp, createdAt) AS grantedExp,
        argMax(ip, createdAt) AS ip,
        argMax(userAgent, createdAt) AS userAgent,
        argMax(deviceId, createdAt) AS deviceId,
        argMax(rank, createdAt) AS rank,
        argMax(originalLevel, createdAt) AS originalLevel
      FROM knights_new_order_image_rating
      WHERE imageId IN (${ids})
      GROUP BY imageId, userId
    )
    SELECT
      userId,
      imageId,
      rating,
      damnedReason,
      if(rating = arrayElement([${rats}], indexOf([${ids}], imageId)), 'Correct', 'Failed') AS status,
      grantedExp,
      if(rating = arrayElement([${rats}], indexOf([${ids}], imageId)), 1, 0) AS multiplier,
      toDateTime('${stampISO}') AS createdAt,
      ip,
      userAgent,
      deviceId,
      rank,
      originalLevel
    FROM latest
    WHERE rank != 'Acolyte'
      AND status IN ('Pending','Inconclusive')
  `;
}

// Resets judgment + fervor counters for every non-Acolyte voter on the given
// images so they lazily rebuild from the freshly re-stamped Correct/Failed rows.
// Returns the number of distinct players reconciled.
export async function reconcileAffectedPlayers(imageIds: number[]): Promise<number> {
  if (!clickhouse) throw new Error('clickhouse not configured');
  if (imageIds.length === 0) return 0;
  const userIds = new Set<number>();
  for (const idChunk of chunk(imageIds, 5000)) {
    // by_imageId projection (GROUP BY imageId,userId + argMax) instead of FINAL scan.
    const rows = await clickhouse.$query<{ userId: number }>`
      SELECT DISTINCT userId FROM (
        SELECT imageId, userId, argMax(rank, createdAt) AS rank
        FROM knights_new_order_image_rating
        WHERE imageId IN (${idChunk.join(',')})
        GROUP BY imageId, userId
      )
      WHERE rank != 'Acolyte'
    `;
    for (const r of rows) userIds.add(r.userId);
  }
  await Promise.all(
    [...userIds].flatMap((id) => [
      correctJudgmentsCounter.reset({ id }),
      allJudgmentsCounter.reset({ id }),
      fervorCounter.reset({ id }),
    ])
  );
  return userIds.size;
}
