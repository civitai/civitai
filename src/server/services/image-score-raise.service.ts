import { chunk } from 'lodash-es';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import type { ImageEngagementDelta } from '~/server/jobs/update-user-score';
import { rollupImageScoreDeltas } from '~/server/jobs/update-user-score';
import {
  countSelfImageEngagement,
  imagesScoreWithoutSelf,
} from '~/server/services/creator-score-self-activity.service';

const IMAGE_BATCH = 10_000;
const REACTION_TYPES = "'Like', 'Heart', 'Laugh', 'Cry'";

type Multipliers = { reactions: number; comments: number };

const idList = (ids: number[]) => {
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0))
    throw new Error('ids must be positive integers');
  return ids.join(',');
};

/**
 * Each owner's `images` score from source as of the cron checkpoint `since`: the backfill's sum over
 * entityMetricDailyAgg_v2, less the owner's own engagement, less what the cron will add for events after
 * `since`. Written as is, the next cron run then adds its window once.
 */
export async function imageScoresAsOf({
  ownerIds,
  since,
  now,
  multipliers,
  excluded,
  pg,
  pgLong,
  ch,
}: {
  ownerIds: number[];
  since: Date;
  now: Date;
  multipliers: Multipliers;
  excluded: Set<number>;
  pg: AugmentedPool;
  pgLong: AugmentedPool;
  ch: CustomClickHouseClient;
}): Promise<Map<number, number>> {
  const scores = new Map<number, number>(ownerIds.map((id) => [id, 0]));
  if (!ownerIds.length) return scores;

  const images = await pg
    .cancellableQuery<{ id: number; userId: number }>(
      `SELECT id, "userId" FROM "Image" WHERE "userId" = ANY($1::int[])`,
      [ownerIds]
    )
    .then((q) => q.result());
  const ownerByImage = new Map(images.map((i) => [Number(i.id), Number(i.userId)]));

  const fromSource = new Map<number, number>();
  const deltas: ImageEngagementDelta[] = [];
  for (const ids of chunk([...ownerByImage.keys()], IMAGE_BATCH)) {
    const totals = await ch.$query<{ imageId: number; reactions: number; comments: number }>(`
      SELECT entityId AS imageId,
        sumIf(total, metricType IN (${REACTION_TYPES})) AS reactions,
        sumIf(total, metricType = 'commentCount') AS comments
      FROM entityMetricDailyAgg_v2
      WHERE entityType = 'Image' AND entityId IN (${idList(ids)})
      GROUP BY entityId
    `);
    for (const t of totals) {
      const owner = ownerByImage.get(Number(t.imageId));
      if (!owner) continue;
      const points =
        Number(t.reactions) * multipliers.reactions + Number(t.comments) * multipliers.comments;
      fromSource.set(owner, (fromSource.get(owner) ?? 0) + points);
    }
    deltas.push(
      ...(await ch.$query<ImageEngagementDelta>(`
        SELECT entityId AS imageId, userId,
          sumIf(metricValue, metricType IN (${REACTION_TYPES})) AS dReactions,
          sumIf(metricValue, metricType = 'commentCount') AS dComments
        FROM entityMetricEvents_month
        WHERE entityType = 'Image' AND entityId IN (${idList(ids)})
          AND metricType IN (${REACTION_TYPES}, 'commentCount')
          AND createdAt > fromUnixTimestamp64Milli(${since.getTime()})
        GROUP BY entityId, userId
        HAVING dReactions != 0 OR dComments != 0
      `))
    );
  }

  const self = await countSelfImageEngagement(
    pgLong,
    ownerIds.filter((id) => !excluded.has(id)),
    now
  );
  const nextCron = rollupImageScoreDeltas(deltas, ownerByImage, multipliers);
  for (const id of ownerIds)
    scores.set(
      id,
      imagesScoreWithoutSelf(fromSource.get(id) ?? 0, self.get(id), multipliers) -
        (nextCron.get(id) ?? 0)
    );
  return scores;
}

export type ImageScoreRaisePlan = {
  ownerId: number;
  stored: number | null;
  recomputed: number;
  action: 'raise' | 'equal' | 'down';
};

/** Only a score that goes up is written; equal and lower ones are reported and left alone. */
export function planImageScoreRaise(
  stored: Map<number, number | null>,
  recomputed: Map<number, number>
): ImageScoreRaisePlan[] {
  return [...recomputed].map(([ownerId, value]) => {
    const before = stored.get(ownerId) ?? null;
    const current = before ?? 0;
    const action = value > current ? 'raise' : value === current ? 'equal' : 'down';
    return { ownerId, stored: before, recomputed: value, action };
  });
}
