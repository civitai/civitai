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
    WITH img AS (
      SELECT imageId, userId, rating, status, originalLevel, createdAt
      FROM knights_new_order_image_rating FINAL
      WHERE rank = 'Knight'
        AND status IN ('Pending','Inconclusive')
        AND createdAt >= '${startDate}'
    ),
    arr AS (
      SELECT imageId,
             count() AS voters,
             groupArray(rating) AS ratings,
             minIf(originalLevel, originalLevel > 0) AS origLevel,
             countIf(status='Pending') AS penCount,
             max(createdAt) AS lastVote
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
  // arrayElement([rats], indexOf([ids], imageId)) -> this image's consensus rating
  await clickhouse.$exec`
    INSERT INTO knights_new_order_image_rating
    SELECT
      orig.userId,
      orig.imageId AS imageId,
      orig.rating,
      orig.damnedReason,
      if(orig.rating = arrayElement([${rats}], indexOf([${ids}], orig.imageId)), 'Correct', 'Failed') AS status,
      orig.grantedExp,
      if(orig.rating = arrayElement([${rats}], indexOf([${ids}], orig.imageId)), 1, 0) AS multiplier,
      toDateTime('${stampISO}') AS createdAt,
      orig.ip, orig.userAgent, orig.deviceId, orig.rank, orig.originalLevel
    FROM knights_new_order_image_rating orig FINAL
    WHERE orig.imageId IN (${ids})
      AND orig.rank != 'Acolyte'
      AND orig.status IN ('Pending','Inconclusive')
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
    const rows = await clickhouse.$query<{ userId: number }>`
      SELECT DISTINCT userId
      FROM knights_new_order_image_rating FINAL
      WHERE imageId IN (${idChunk.join(',')}) AND rank != 'Acolyte'
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
