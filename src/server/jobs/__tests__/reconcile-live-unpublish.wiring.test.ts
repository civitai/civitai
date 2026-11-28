import { describe, expect, it } from 'vitest';
import { reconcileLiveUnpublishJob } from '~/server/jobs/reconcile-live-unpublish';
import { jobsArrayEntries } from './run-jobs-array';

/**
 * The entry in the `jobs` array IS the scheduling: without it no suspended app taken down before
 * the flag was on is ever unpublished, and a failed takedown Job is never retried. Its behaviour
 * is in `live-unpublish.service.test.ts` (`reconcileSuspendedLiveApps`).
 */
describe('reconcile-live-unpublish — wiring', () => {
  it('is registered in the jobs array the scheduler reads, hourly, with a lock longer than a batch', () => {
    expect(jobsArrayEntries()).toContain('reconcileLiveUnpublishJob');
    expect(reconcileLiveUnpublishJob.name).toBe('reconcile-live-unpublish');
    expect(reconcileLiveUnpublishJob.cron).toBe('17 * * * *');
    expect(reconcileLiveUnpublishJob.options.lockExpiration).toBe(3600);
  });
});
