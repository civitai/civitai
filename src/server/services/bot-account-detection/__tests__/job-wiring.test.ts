import { describe, expect, it } from 'vitest';
import { botAccountDetection } from '~/server/jobs/bot-account-detection';
import { UNRUNNABLE_JOB_CRON } from '~/server/jobs/job';

/**
 * How this job is REGISTERED, as distinct from what it does.
 *
 * `/api/internal/get-jobs` publishes every registered job's cron to the external scheduler, so the
 * cron string in the job file is not documentation — it is the deployment. A real cron here means
 * merging this PR turns the detector on, against preconditions (`MOD_INBOUND_TOKEN` set, the
 * abuse-detection schema applied to `MODERATOR_DATABASE_URL`) that are applied by hand and are not
 * checked by anything. That is a daily 500, repeating until a human notices.
 */
describe('the bot-account detection job is registered but NOT scheduled', () => {
  it('carries the unrunnable cron, so merging does not enable it', () => {
    expect(botAccountDetection.cron).toBe(UNRUNNABLE_JOB_CRON);
  });

  it('is still named and runnable on demand', () => {
    // The point of `UNRUNNABLE_JOB_CRON` over deleting the registration: the job stays reachable at
    // `/api/webhooks/run-jobs/bot-account-detection`, which is exactly what a shadow-phase grading
    // pass needs.
    expect(botAccountDetection.name).toBe('bot-account-detection');
    expect(typeof botAccountDetection.run).toBe('function');
  });

  it('holds its lock for longer than a capped run can take', () => {
    // 🔴 The run-jobs route hard-caps the lock hold at `lockExpiration` and then RELEASES the lock
    // WHILE the run continues (`acquireLock`'s refresh interval, `src/pages/api/webhooks/
    // run-jobs/[[...run]].ts`). Past that point a retry can start a second full run whose
    // different `startedAt` the board's `(detector, started_at)` key cannot merge with the first,
    // and the board shows two complete duplicate finding sets. The default 5 minutes is not enough
    // headroom for a walk of up to `MAX_COHORT_ACCOUNTS` accounts.
    expect(botAccountDetection.options.lockExpiration).toBeGreaterThanOrEqual(30 * 60);
  });
});
