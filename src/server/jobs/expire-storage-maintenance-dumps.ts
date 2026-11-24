import { logToAxiom } from '~/server/logging/client';
import { expireStorageMaintenanceDumps } from '~/server/services/apps/storage-mark-migration.service';
import { createJob } from './job';

/**
 * APP STORAGE PURGE DUMPS — retention. A per-collection purge (`apps.mod.docStore.maintenance.*`)
 * dumps every row it deletes into the store's maintenance runs; this job deletes the dumps of every
 * purge that finished 30 days ago or more (`expireStorageMaintenanceDumps`), keeping each purge's
 * header and counts. Daily. FAIL-OPEN like the sibling reapers: an error is logged and the next
 * run retries.
 */
export const expireStorageMaintenanceDumpsJob = createJob(
  'expire-storage-maintenance-dumps',
  '23 4 * * *',
  async (jobContext) => {
    try {
      const result = await expireStorageMaintenanceDumps({
        checkIfCanceled: () => jobContext.checkIfCanceled(),
      });
      if (result.dumps > 0 || result.failures > 0) {
        logToAxiom(
          { name: 'expire-storage-maintenance-dumps', type: 'info', ...result },
          'app-blocks'
        );
      }
      return result;
    } catch (error) {
      logToAxiom(
        {
          name: 'expire-storage-maintenance-dumps',
          type: 'error',
          message: (error as Error)?.message,
          stack: (error as Error)?.stack,
        },
        'app-blocks'
      );
      return { error: true as const };
    }
  }
);
