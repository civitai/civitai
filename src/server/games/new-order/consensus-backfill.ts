import { clickhouse } from '~/server/clickhouse/client';

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
