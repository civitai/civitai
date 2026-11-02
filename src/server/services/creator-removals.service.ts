import { chunk } from 'lodash-es';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  REMOVAL_RESTORED_EVENT,
  REMOVAL_SCORE_WINDOW_DAYS,
  REPORTS_AGAINST_EVENT,
} from '~/shared/constants/creator-journey.constants';
import { removalWeight } from '~/shared/utils/creator-removal-weights';

/**
 * The one definition of a counted removal: an image's latest removal, unless a restore event, an
 * approved image appeal or a score exemption came after it. The score job and the removed-images
 * list both read it.
 */
export type CreatorRemoval = {
  ownerId: number;
  imageId: number;
  removedAt: number;
  /** The latest removal's `violationType`, else its `tosReason`; null when it recorded neither. */
  reason?: string | null;
};

/** The reason the score weighs a removal by: its latest `violationType`, else its `tosReason`. */
export const REMOVAL_REASON_SQL = `coalesce(
      nullIf(argMaxIf(violationType, time, type = '${REPORTS_AGAINST_EVENT}'), ''),
      argMaxIf(tosReason, time, type = '${REPORTS_AGAINST_EVENT}')
    )`;

/**
 * ClickHouse half: one row per image of the owners `ownerFilter` selects, with its latest removal in
 * unix seconds. A removal a later restore event reversed is dropped here.
 */
export const removalsQuery = (ownerFilter: string) => `
  SELECT ownerId, imageId, toUnixTimestamp(maxIf(time, type = '${REPORTS_AGAINST_EVENT}')) AS removedAt,
    ${REMOVAL_REASON_SQL} AS reason
  FROM images
  WHERE type IN ('${REPORTS_AGAINST_EVENT}', '${REMOVAL_RESTORED_EVENT}') AND ${ownerFilter}
  GROUP BY ownerId, imageId
  HAVING maxIf(time, type = '${REPORTS_AGAINST_EVENT}') > maxIf(time, type = '${REMOVAL_RESTORED_EVENT}')
`;

const BATCH = 10_000;

/** Postgres half: drops each removal an image appeal approved, or a score exemption covered, after it. */
export async function withoutReversed<T extends CreatorRemoval>(
  removals: T[],
  db: typeof dbRead = dbRead
) {
  const reversed = new Set<number>();
  for (const batch of chunk(removals, BATCH)) {
    const rows = await db.$queryRaw<{ imageId: number }[]>`
      SELECT r."imageId"
      FROM unnest(${batch.map((r) => Number(r.imageId))}::int[], ${batch.map((r) =>
      Number(r.removedAt)
    )}::bigint[]) AS r("imageId", "removedAt")
      WHERE EXISTS (
        SELECT 1 FROM "Appeal" a
        WHERE a."entityType" = 'Image' AND a."entityId" = r."imageId" AND a.status = 'Approved'
          AND a."resolvedAt" > to_timestamp(r."removedAt") AT TIME ZONE 'UTC'
      ) OR EXISTS (
        SELECT 1 FROM "RemovalScoreExemption" e
        WHERE e."imageId" = r."imageId"
          AND e."createdAt" >= to_timestamp(r."removedAt") AT TIME ZONE 'UTC'
      )
    `;
    for (const { imageId } of rows) reversed.add(Number(imageId));
  }
  return removals.filter((r) => !reversed.has(Number(r.imageId)));
}

const DAY_MS = 86_400_000;

/** A removal made at or before this no longer counts towards the score. */
export const removalWindowStart = (now: Date) =>
  new Date(now.getTime() - REMOVAL_SCORE_WINDOW_DAYS * DAY_MS);

/** Whether a removal made at `removedAt` (unix seconds) is still inside the window. */
export const isWithinRemovalWindow = (removedAt: number | string, now: Date) =>
  Number(removedAt) * 1000 > removalWindowStart(now).getTime();

/** Whether a removal currently costs points: inside the window, and of a reason that weighs. */
export const costsPoints = (removal: CreatorRemoval, now: Date) =>
  isWithinRemovalWindow(removal.removedAt, now) && removalWeight(removal.reason) > 0;

/**
 * Each owner's total removal weight within the last `REMOVAL_SCORE_WINDOW_DAYS`, every removal
 * weighed by its reason (1 per fully weighted removal); an owner with none is absent. Checks
 * appeals on the primary, like `getOwnersWithReversalsSince`, so an owner re-scored for a new
 * approval is scored with it.
 */
export async function removalPenaltyWeightsByOwner(
  ch: CustomClickHouseClient,
  ownerIds: number[],
  now = new Date()
) {
  const weights = new Map<number, number>();
  for (const owners of chunk(ownerIds, 1000)) {
    const rows = await ch.$query<CreatorRemoval>(removalsQuery(`ownerId IN (${owners.join(',')})`));
    const inWindow = rows.filter((r) => costsPoints(r, now));
    for (const { ownerId, reason } of await withoutReversed(inWindow, dbWrite))
      weights.set(Number(ownerId), (weights.get(Number(ownerId)) ?? 0) + removalWeight(reason));
  }
  return weights;
}

export const reportsAgainstScore = (penaltyWeight: number | undefined, multiplier: number) =>
  penaltyWeight ? penaltyWeight * multiplier : 0;

/**
 * Owners with a removal reversed since `since`, by a restore event, an approved image appeal or a new
 * score exemption.
 */
export async function getOwnersWithReversalsSince(ch: CustomClickHouseClient, since: Date) {
  // Primary, not the replica: an approval or exemption the replica has not seen yet would fall
  // behind the job's next checkpoint.
  const approved = await dbWrite.$queryRaw<{ imageId: number }[]>`
    SELECT DISTINCT "entityId" AS "imageId" FROM "Appeal"
    WHERE "entityType" = 'Image' AND status = 'Approved' AND "resolvedAt" > ${since}
    UNION
    SELECT "imageId" FROM "RemovalScoreExemption" WHERE "createdAt" > ${since}
  `;
  const restored = await ch.$query<{ ownerId: number }>`
    SELECT DISTINCT ownerId FROM images
    WHERE type = '${REMOVAL_RESTORED_EVENT}' AND time > ${since}
  `;
  const owners = new Set(restored.map((r) => Number(r.ownerId)));
  for (const ids of chunk(
    approved.map((r) => Number(r.imageId)),
    BATCH
  )) {
    const rows = await ch.$query<{ ownerId: number }>(`
      SELECT DISTINCT ownerId FROM images
      WHERE type = '${REPORTS_AGAINST_EVENT}' AND imageId IN (${ids.join(',')})
    `);
    for (const { ownerId } of rows) owners.add(Number(ownerId));
  }
  return [...owners];
}

/**
 * Owners with a counted removal that left the window between `since` and `now`: made after
 * `since` minus the window and up to `now` minus it. The nightly job re-scores them, as nothing new
 * happened to them since its last run.
 */
// Relies on the job's checkpoint being taken before this run's `now`, so consecutive ranges
// overlap rather than skip.
export async function getOwnersWithRemovalsAgedOutSince(
  ch: CustomClickHouseClient,
  since: Date,
  now: Date
) {
  const from = removalWindowStart(since);
  const to = removalWindowStart(now);
  const rows = await ch.$query<{ ownerId: number }>`
    SELECT DISTINCT ownerId
    FROM images
    WHERE type IN ('${REPORTS_AGAINST_EVENT}', '${REMOVAL_RESTORED_EVENT}') AND time > ${from}
    GROUP BY ownerId, imageId
    HAVING maxIf(time, type = '${REPORTS_AGAINST_EVENT}') > maxIf(time, type = '${REMOVAL_RESTORED_EVENT}')
      AND maxIf(time, type = '${REPORTS_AGAINST_EVENT}') > ${from}
      AND maxIf(time, type = '${REPORTS_AGAINST_EVENT}') <= ${to}
  `;
  return rows.map((r) => Number(r.ownerId));
}

/**
 * One page of owners with a removal event, whether or not it still counts: those with an id above
 * `after`, in id order.
 */
export async function getOwnersWithRemovals(
  ch: CustomClickHouseClient,
  after: number,
  limit: number
) {
  const rows = await ch.$query<{ ownerId: number }>(
    `SELECT DISTINCT ownerId FROM images
     WHERE type = '${REPORTS_AGAINST_EVENT}' AND ownerId > ${Math.trunc(after)}
     ORDER BY ownerId LIMIT ${Math.trunc(limit)}`
  );
  return rows.map((r) => Number(r.ownerId));
}
