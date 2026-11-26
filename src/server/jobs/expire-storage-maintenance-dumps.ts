import { logToAxiom } from '~/server/logging/client';
import { expireStorageMaintenanceDumps } from '~/server/services/apps/storage-mark-migration.service';
import { createJob } from './job';

/**
 * APP STORAGE PURGE DUMPS — retention: deletes the dumps of purges finished (or abandoned)
 * `PURGE_DUMP_RETENTION_DAYS` ago (`expireStorageMaintenanceDumps`). Daily. Inert until the
 * `maint_run` datastore migration is applied. FAIL-OPEN: an error is logged and the next run retries.
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
