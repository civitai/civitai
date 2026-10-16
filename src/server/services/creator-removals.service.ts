import { chunk } from 'lodash-es';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  REMOVAL_RESTORED_EVENT,
  REPORTS_AGAINST_EVENT,
} from '~/shared/constants/creator-journey.constants';

/**
 * The one definition of a counted removal: an image's latest removal, unless a restore event, an
 * approved image appeal or a score exemption came after it. The score job and the removed-images
 * list both read it.
 */
export type CreatorRemoval = { ownerId: number; imageId: number; removedAt: number };

/**
 * ClickHouse half: one row per image of the owners `ownerFilter` selects, with its latest removal in
 * unix seconds. A removal a later restore event reversed is dropped here.
 */
export const removalsQuery = (ownerFilter: string) => `
  SELECT ownerId, imageId, toUnixTimestamp(maxIf(time, type = '${REPORTS_AGAINST_EVENT}')) AS removedAt
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

/**
 * Counted removals per owner; an owner with none is absent. Checks appeals on the primary, like
 * `getOwnersWithReversalsSince`, so an owner re-scored for a new approval is scored with it.
 */
export async function countRemovalsByOwner(ch: CustomClickHouseClient, ownerIds: number[]) {
  const counts = new Map<number, number>();
  for (const owners of chunk(ownerIds, 1000)) {
    const rows = await ch.$query<CreatorRemoval>(removalsQuery(`ownerId IN (${owners.join(',')})`));
    for (const { ownerId } of await withoutReversed(rows, dbWrite))
      counts.set(Number(ownerId), (counts.get(Number(ownerId)) ?? 0) + 1);
  }
  return counts;
}

export const reportsAgainstScore = (count: number | undefined, multiplier: number) =>
  count ? count * multiplier : 0;

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
