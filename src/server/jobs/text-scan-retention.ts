import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import {
  getTextScanMode,
  getTextScanWebSearchMode,
  TEXT_SCAN_ENTITY_TYPES,
  TEXT_SCAN_WEB_SEARCH_ENTITY_TYPES,
  textScanEmEntityType,
} from '~/server/services/text-scan/mode';
import { cleanupTextScanRows } from '~/server/services/text-scan/retention';
import type { TextScanEntityType } from '~/server/services/text-scan/types';

const PROBE = 20;
const OLDER_THAN_DAYS = 30;

// Mode is per entity id, so "graduated" is read off the ids that still have shadow rows: a partial
// active ramp or a rollback keeps the rows.
async function graduatedEntityTypes(
  entityTypes: readonly TextScanEntityType[],
  shadowRowType: (entityType: TextScanEntityType) => string,
  getMode: (entityType: TextScanEntityType, entityId: number) => Promise<string>
) {
  const graduated: TextScanEntityType[] = [];
  for (const entityType of entityTypes) {
    const rows = await dbRead.entityModeration.findMany({
      where: { entityType: shadowRowType(entityType) },
      select: { entityId: true },
      orderBy: { entityId: 'desc' },
      take: PROBE,
    });
    if (!rows.length) continue;
    const modes = await Promise.all(rows.map((r) => getMode(entityType, r.entityId)));
    if (modes.every((m) => m === 'active')) graduated.push(entityType);
  }
  return graduated;
}

export const textScanRetention = createJob('text-scan-retention', '40 4 * * *', async () => {
  const graduated = await graduatedEntityTypes(
    TEXT_SCAN_ENTITY_TYPES,
    (t) => textScanEmEntityType(t, 'shadow'),
    getTextScanMode
  );
  const graduatedWebSearch = await graduatedEntityTypes(
    TEXT_SCAN_WEB_SEARCH_ENTITY_TYPES,
    (t) => textScanEmEntityType(t, 'shadow', 'web-search'),
    (t, id) => getTextScanWebSearchMode(t, id)
  );
  const result = await cleanupTextScanRows({
    graduatedEntityTypes: graduated,
    graduatedWebSearchEntityTypes: graduatedWebSearch,
    olderThanDays: OLDER_THAN_DAYS,
  });
  return { graduated, graduatedWebSearch, ...result };
});
