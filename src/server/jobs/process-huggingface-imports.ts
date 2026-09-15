import { randomUUID } from 'crypto';
import { createJob } from './job';
import { processImportQueue } from '~/server/services/huggingface-import.service';

/**
 * The budget must leave room for the SLOWEST part still in flight when it expires, or the lock lapses
 * mid-run and the next tick starts a second run on the same pod — each one holding its own part
 * buffers. 2 minutes of work under a 5-minute lock leaves 3 minutes of headroom.
 */
const WORK_BUDGET_MS = 2 * 60 * 1000;
const LOCK_EXPIRATION_SECONDS = 5 * 60;

export const processHuggingFaceImportsJob = createJob(
  'process-huggingface-imports',
  '* * * * *',
  async () => {
    const { moved } = await processImportQueue({
      deadline: Date.now() + WORK_BUDGET_MS,
      worker: `${process.env.HOSTNAME ?? 'local'}:${randomUUID().slice(0, 8)}`,
    });
    return { moved };
  },
  // `keepLockOnDisconnect`: this run legitimately outlives the scheduler's client timeout. A second
  // run would not collide — the lock is fleet-wide, and `SKIP LOCKED` plus the heartbeat send it to
  // different files — it would simply transfer more at once, on whichever pod the scheduler hit.
  { lockExpiration: LOCK_EXPIRATION_SECONDS, keepLockOnDisconnect: true }
);
