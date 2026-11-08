import { logToAxiom } from '~/server/logging/client';
import { resumeStorageMigrationRuns } from '~/server/services/apps/storage-migration-run.service';
import { createJob } from './job';

/**
 * APP STORAGE SCHEMA MIGRATIONS — resume. `approveRequest` records a version's migration plan
 * (`app_storage_migration_runs`) and starts it in the background; this job finishes whatever that
 * start did not: a run the process lost (restart, deploy), one that ran out of its page budget,
 * one the store refused while unreachable. A run whose heartbeat went stale is re-claimed; the ops
 * are idempotent, so re-running pages a lost run already did is safe. Every 10 minutes: a run
 * left behind waits at most that long, and with nothing to do the job is one indexed read.
 * Runs of an app the operator holds (`app-blocks-storage-migration-hold`) are skipped and counted
 * as `held`. FAIL-OPEN like the sibling reapers: an error is logged and the next run retries.
 */
export const runStorageMigrationsJob = createJob(
  'run-storage-migrations',
  '*/10 * * * *',
  async (jobContext) => {
    try {
      const result = await resumeStorageMigrationRuns({
        checkIfCanceled: () => jobContext.checkIfCanceled(),
      });
      if (result.advanced > 0 || result.held > 0) {
        logToAxiom({ name: 'run-storage-migrations', type: 'info', ...result }, 'app-blocks').catch(
          () => undefined
        );
      }
      return result;
    } catch (error) {
      logToAxiom(
        {
          name: 'run-storage-migrations',
          type: 'error',
          message: (error as Error)?.message,
          stack: (error as Error)?.stack,
        },
        'app-blocks'
      ).catch(() => undefined);
      return { error: true as const };
    }
  }
);
