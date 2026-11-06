import { createJob } from './job';
import {
  archiveStudioDataset,
  getPendingStudioDatasetFileIds,
} from '~/server/services/orchestrator/training/studio-dataset-archive.service';

// Each file is fetched and uploaded in full, so a run stops starting new ones after this budget; the
// lock below leaves room for the one still in flight.
const WORK_BUDGET_MS = 4 * 60 * 1000;
const LOCK_EXPIRATION_SECONDS = 10 * 60;
const FILES_PER_RUN = 25;

/** Turns Training Studio's 0-byte `Training Data` placeholders into the run's real dataset zip. */
export const archiveStudioTrainingDatasetsJob = createJob(
  'archive-studio-training-datasets',
  '*/5 * * * *',
  async (jobContext) => {
    const deadline = Date.now() + WORK_BUDGET_MS;
    const fileIds = await getPendingStudioDatasetFileIds(FILES_PER_RUN);
    const counts = { archived: 0, unavailable: 0, retry: 0, skipped: 0 };
    for (const fileId of fileIds) {
      if (Date.now() > deadline) break;
      jobContext.checkIfCanceled();
      const result = await archiveStudioDataset(fileId);
      counts[result.outcome] += 1;
    }
    return { pending: fileIds.length, ...counts };
  },
  // A run legitimately outlives the scheduler's client timeout, and a second concurrent run would
  // archive the same newest placeholders twice.
  { lockExpiration: LOCK_EXPIRATION_SECONDS, keepLockOnDisconnect: true }
);
