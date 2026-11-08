import { createJob } from './job';
import { runPersonalDataExports } from '~/server/services/personal-data-export/personal-data-export.service';

/**
 * One export per tick, streamed end to end. The lock outlasts one large build, so
 * two runs never take the same queue; `claimNextExport`'s SKIP LOCKED is the second guard, and
 * `recoverStaleExports` returns a build abandoned by a crash to the queue.
 */
export const PERSONAL_DATA_EXPORT_LOCK_SECONDS = 3 * 60 * 60;

export const buildPersonalDataExportsJob = createJob(
  'build-personal-data-exports',
  '*/10 * * * *',
  async () => runPersonalDataExports(),
  {
    lockExpiration: PERSONAL_DATA_EXPORT_LOCK_SECONDS,
    keepLockOnDisconnect: true,
  }
);
