import { createLogger } from '~/utils/logging';
import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { chunk } from 'lodash-es';

const log = createLogger('remove-old-drafts');

export const removeOldDrafts = createJob('remove-old-drafts', '43 2 * * *', async () => {
  // Step 1: Query replica (dbRead) for model IDs to delete
  // This offloads the read operation from the write database and prevents lock contention
  // Uses Model.status (indexed) instead of ModelMetric.status for faster lookups
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT DISTINCT m.id
    FROM "Model" m
    JOIN "ModelMetric" mm ON mm."modelId" = m.id
    WHERE m.status IN ('Draft', 'Deleted')
      AND m."updatedAt" < now() - INTERVAL '30 days'
      AND mm."downloadCount" < 10
    ORDER BY m.id  -- Consistent lock ordering to prevent deadlocks
  `;

  if (rows.length === 0) {
    log('No old draft models found for removal');
    logToAxiom({ type: 'info', name: 'remove-old-drafts', message: 'No old draft models found' });
    return;
  }

  // Step 2: Delete in batches using dbWrite to minimize lock duration
  // Small batch size (10) because each Model delete cascades to 20+ related tables
  const modelIds = rows.map((r) => r.id);
  const BATCH_SIZE = 10;
  let deletedCount = 0;
  let errorCount = 0;

  log(`Found ${modelIds.length} old draft models to remove`);

  const batches = chunk(modelIds, BATCH_SIZE);
  for (const batch of batches) {
    try {
      await dbWrite.$executeRaw`
        DELETE FROM "Model"
        WHERE id = ANY(${batch})
      `;
      deletedCount += batch.length;
    } catch (error) {
      const e = error as Error;
      errorCount += batch.length;
      logToAxiom({
        type: 'error',
        name: 'remove-old-drafts',
        message: `Failed to remove batch of old draft models`,
        error: e.message,
        stack: e.stack,
      });
      // Continue with remaining batches even if one fails
    }
  }

  log(`Removed ${deletedCount} old draft models${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
});
