import { Prisma } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { GetUserDownloadsSchema, HideDownloadInput } from '~/server/schema/download.schema';
import { getUserSettings, setUserSetting } from '~/server/services/user.service';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getUserDownloads = async ({
  limit = DEFAULT_PAGE_SIZE,
  userId,
  cursor,
}: Partial<GetUserDownloadsSchema> & {
  userId: number;
}) => {
  const { hideDownloadsSince } = await getUserSettings(userId);

  if (!clickhouse) {
    return { items: [], nextCursor: undefined };
  }

  // Build WHERE conditions
  const conditions: string[] = [`userId = ${userId}`];
  if (cursor) {
    const cursorDate = new Date(cursor).toISOString().replace(/\.\d{3}Z$/, 'Z');
    conditions.push(`lastDownloaded < parseDateTime64BestEffort('${cursorDate}')`);
  }
  if (hideDownloadsSince) {
    const sinceDate = new Date(hideDownloadsSince).toISOString().replace(/\.\d{3}Z$/, 'Z');
    conditions.push(`lastDownloaded > parseDateTime64BestEffort('${sinceDate}')`);
  }

  const whereClause = conditions.join(' AND ');

  // Fetch limit + 1 to detect if there's more data
  const fetchLimit = limit + 1;
  const downloadHistory = await clickhouse.$query<{
    modelVersionId: number;
    downloadAt: Date;
  }>`
    SELECT
      modelVersionId,
      max(lastDownloaded) as downloadAt
    FROM userModelDownloads
    WHERE ${whereClause}
    GROUP BY modelVersionId
    ORDER BY max(lastDownloaded) DESC
    LIMIT ${fetchLimit}
  `;

  // Determine pagination from ClickHouse results BEFORE filtering
  const hasMore = downloadHistory.length > limit;
  let nextCursor: Date | undefined;
  if (hasMore) {
    // Cursor is from the extra item (position `limit`)
    nextCursor = downloadHistory[limit].downloadAt;
  }

  // Work with only the first `limit` items for filtering
  const itemsToProcess = downloadHistory.slice(0, limit);

  if (itemsToProcess.length === 0) {
    return { items: [], nextCursor: undefined };
  }

  // Get model/version IDs from download history
  const downloadedVersionIds = itemsToProcess.map((dh) => dh.modelVersionId);

  // Check which of these downloads are hidden
  const hiddenDownloads = await dbRead.$queryRaw<{ modelVersionId: number }[]>`
    SELECT "modelVersionId"
    FROM "HiddenDownload"
    WHERE "userId" = ${userId}
      AND "modelVersionId" IN (${Prisma.join(downloadedVersionIds)})
  `;
  const hiddenIds = hiddenDownloads.map((h) => h.modelVersionId);

  // Filter out hidden downloads
  const visibleDownloads = itemsToProcess.filter((dh) => !hiddenIds.includes(dh.modelVersionId));

  if (visibleDownloads.length === 0) {
    // No visible items on this page, but there may be more pages
    return { items: [], nextCursor };
  }

  // Get model/version names from PostgreSQL in a separate query
  const modelVersionIds = visibleDownloads.map((dh) => dh.modelVersionId);

  const modelVersions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: {
      id: true,
      name: true,
      model: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  // Create a map for quick lookup
  const versionMap = new Map(modelVersions.map((mv) => [mv.id, mv]));

  // Combine the data
  const items = visibleDownloads.map((dh) => {
    const version = versionMap.get(dh.modelVersionId);
    return {
      downloadAt: dh.downloadAt,
      modelVersion: {
        id: dh.modelVersionId,
        name: version?.name ?? 'Unknown',
        model: {
          id: version?.model.id ?? 0,
          name: version?.model.name ?? 'Unknown',
        },
      },
    };
  });

  return { items, nextCursor };
};

export const hideDownload = async ({
  modelVersionId,
  userId,
  all = false,
}: HideDownloadInput & { userId: number }) => {
  if (all) {
    // Hide all downloads using hideDownloadsSince setting
    return setUserSetting(userId, { hideDownloadsSince: Date.now() });
  }

  if (!modelVersionId) {
    throw new Error('modelVersionId is required to hide individual downloads');
  }

  await dbWrite.$executeRaw`
    INSERT INTO "HiddenDownload" ("userId", "modelVersionId", "createdAt")
    VALUES (${userId}, ${modelVersionId}, NOW())
    ON CONFLICT ("userId", "modelVersionId") DO NOTHING
  `;
};
