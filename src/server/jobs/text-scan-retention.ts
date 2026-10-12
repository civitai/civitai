import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import {
  getTextScanMode,
  TEXT_SCAN_ENTITY_TYPES,
  textScanEmEntityType,
} from '~/server/services/text-scan/mode';
import { cleanupTextScanRows } from '~/server/services/text-scan/retention';
import type { TextScanEntityType } from '~/server/services/text-scan/types';

const PROBE = 20;
const OLDER_THAN_DAYS = 30;

// Mode is per entity id, so "graduated" is read off the ids that still have shadow rows: a partial
// active ramp or a rollback keeps the rows.
async function graduatedEntityTypes() {
  const graduated: TextScanEntityType[] = [];
  for (const entityType of TEXT_SCAN_ENTITY_TYPES) {
    const rows = await dbRead.entityModeration.findMany({
      where: { entityType: textScanEmEntityType(entityType, 'shadow') },
      select: { entityId: true },
      orderBy: { entityId: 'desc' },
      take: PROBE,
    });
    if (!rows.length) continue;
    const modes = await Promise.all(rows.map((r) => getTextScanMode(entityType, r.entityId)));
    if (modes.every((m) => m === 'active')) graduated.push(entityType);
  }
  return graduated;
}

export const textScanRetention = createJob('text-scan-retention', '40 4 * * *', async () => {
  const graduated = await graduatedEntityTypes();
  const result = await cleanupTextScanRows({
    graduatedEntityTypes: graduated,
    olderThanDays: OLDER_THAN_DAYS,
  });
  return { graduated, ...result };
});
