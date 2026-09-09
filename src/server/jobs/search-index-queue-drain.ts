import { logToAxiom } from '~/server/logging/client';
import { drainDroppedEnqueues } from '~/server/redis/queues';
import { createJob } from './job';

// Replays search-index and metrics enqueues that were parked in Postgres because
// sysRedis was degraded when a content mutation tried to queue them. Deletes are the
// reason it runs: an update is re-derived by the delta `updatedAt` range-scan, while a
// delete has no surviving row to re-derive it from, so a dropped one leaves the
// document in the index permanently.
export const searchIndexQueueDrainJob = createJob(
  'search-index-queue-drain',
  '*/5 * * * *',
  async () => {
    const result = await drainDroppedEnqueues();
    if (result.keys === 0) return;

    // `reparked` is not a failure of this job — sysRedis is still degraded and the ids
    // are safe — but it is the signal that the outage is ongoing rather than a blip.
    logToAxiom({
      type: result.reparked > 0 ? 'warning' : 'info',
      name: 'search-index-queue-drain',
      message:
        `replayed ${result.replayed} id(s) across ${result.keys} key(s)` +
        (result.reparked > 0 ? `, ${result.reparked} re-parked (sysRedis still degraded)` : ''),
    }).catch(() => undefined);

    return result;
  },
  // Twice the cron period. createJob's default lockExpiration is 300s, which is
  // exactly this job's interval — a run lasting any time at all could have its lock
  // expire as the next one fires. Overlapping runs are safe (both delete under a row
  // lock, so the second finds nothing), but a lock that cannot outlive its own period
  // is not a lock.
  { lockExpiration: 10 * 60 }
);
