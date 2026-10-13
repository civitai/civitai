import { chunk } from 'lodash-es';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import {
  REMOVAL_RESTORED_EVENT,
  REPORTS_AGAINST_EVENT,
} from '~/shared/constants/creator-journey.constants';

/**
 * The one definition of a removal that counts toward a creator's "Removed content": an image's latest
 * removal, unless a restore event or an approved image appeal came after it. The score job and the
 * member's removed-images list both read it, so the list keeps matching the score.
 */

export type Removal = { ownerId: number; imageId: number; removedAt: number };

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

/** Postgres half: drops each removal an image appeal approved after it. */
export async function withoutAppealReversed<T extends Removal>(removals: T[]) {
  const reversed = new Set<number>();
  for (const batch of chunk(removals, BATCH)) {
    const rows = await dbRead.$queryRaw<{ imageId: number }[]>`
      SELECT r."imageId"
      FROM unnest(${batch.map((r) => Number(r.imageId))}::int[], ${batch.map((r) =>
      Number(r.removedAt)
    )}::bigint[]) AS r("imageId", "removedAt")
      WHERE EXISTS (
        SELECT 1 FROM "Appeal" a
        WHERE a."entityType" = 'Image' AND a."entityId" = r."imageId" AND a.status = 'Approved'
          AND a."resolvedAt" > to_timestamp(r."removedAt") AT TIME ZONE 'UTC'
      )
    `;
    for (const { imageId } of rows) reversed.add(Number(imageId));
  }
  return removals.filter((r) => !reversed.has(Number(r.imageId)));
}

/** Counted removals per owner; an owner with none is absent. */
export async function countRemovalsByOwner(ch: CustomClickHouseClient, ownerIds: number[]) {
  const counts = new Map<number, number>();
  for (const owners of chunk(ownerIds, 1000)) {
    const rows = await ch.$query<Removal>(removalsQuery(`ownerId IN (${owners.join(',')})`));
    for (const { ownerId } of await withoutAppealReversed(rows))
      counts.set(Number(ownerId), (counts.get(Number(ownerId)) ?? 0) + 1);
  }
  return counts;
}

/** Images with an image appeal approved since `since`; their owners need re-scoring. */
export async function getImagesApprovedOnAppealSince(since: Date) {
  const rows = await dbRead.$queryRaw<{ imageId: number }[]>`
    SELECT DISTINCT "entityId" AS "imageId" FROM "Appeal"
    WHERE "entityType" = 'Image' AND status = 'Approved' AND "resolvedAt" > ${since}
  `;
  return rows.map((r) => Number(r.imageId));
}

/** Owners with a removal of any of these images. */
export async function getRemovedImageOwners(ch: CustomClickHouseClient, imageIds: number[]) {
  const owners = new Set<number>();
  for (const ids of chunk(imageIds, BATCH)) {
    const rows = await ch.$query<{ ownerId: number }>(`
      SELECT DISTINCT ownerId FROM images
      WHERE type = '${REPORTS_AGAINST_EVENT}' AND imageId IN (${ids.join(',')})
    `);
    for (const { ownerId } of rows) owners.add(Number(ownerId));
  }
  return [...owners];
}
