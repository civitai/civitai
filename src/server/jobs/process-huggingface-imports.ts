import { randomUUID } from 'crypto';
import { createJob } from './job';
import { getHuggingFaceImportConfig } from '~/server/services/huggingface-import-config.service';
import { processImportQueue } from '~/server/services/huggingface-import.service';

/**
 * The per-run budget is operator-set (`workBudgetSeconds`, capped at 240) and must leave room for the
 * SLOWEST part still in flight when it expires — otherwise the lock lapses mid-run and the next tick
 * starts a second run. This lock is the ceiling that cap is chosen against.
 */
const LOCK_EXPIRATION_SECONDS = 5 * 60;

export const processHuggingFaceImportsJob = createJob(
  'process-huggingface-imports',
  '* * * * *',
  async () => {
    const config = await getHuggingFaceImportConfig();
    // The kill switch stops this run claiming anything; queued rows are left exactly as they are, so
    // turning it back on resumes rather than restarts.
    if (!config.enabled) return { skipped: 'disabled' };

    const { moved, bytes } = await processImportQueue({
      deadline: Date.now() + config.workBudgetSeconds * 1000,
      worker: `${process.env.HOSTNAME ?? 'local'}:${randomUUID().slice(0, 8)}`,
      concurrency: config.filesInParallel,
      partsInFlight: config.partsInFlight,
    });
    return { moved, bytes };
  },
  // `keepLockOnDisconnect`: this run legitimately outlives the scheduler's client timeout. A second
  // run would not collide — the lock is fleet-wide, and `SKIP LOCKED` plus the heartbeat send it to
  // different files — it would simply transfer more at once, on whichever pod the scheduler hit.
  { lockExpiration: LOCK_EXPIRATION_SECONDS, keepLockOnDisconnect: true }
);
