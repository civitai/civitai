import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { gdprStripeScrubJob } from '~/server/jobs/gdpr-stripe-scrub';

/**
 * The entry in the `jobs` array IS the scheduling — a separate service reads that array and
 * registers a trigger per entry. Drop the entry and nothing fails: the job simply never runs, and
 * every alert this work relies on lives inside it, so the silence would look like success.
 *
 * The route is read as source rather than imported, because importing it pulls in every job in the
 * application. The claim is about one line of a list, and a list can be asked about directly.
 */
const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);

describe('gdpr-stripe-scrub — wiring', () => {
  it('is registered in the jobs array the scheduler reads', () => {
    const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
    const start = source.indexOf('export const jobs: Job[] = [');
    expect(start).toBeGreaterThan(-1);
    const array = source.slice(start, source.indexOf('];', start));

    expect(array).toContain('gdprStripeScrubJob');
    expect(source).toContain("from '~/server/jobs/gdpr-stripe-scrub'");
  });

  it('publishes a real cron, and a lock that outlasts its own run budget', () => {
    expect(gdprStripeScrubJob.cron).toBe('*/10 * * * *');
    // The lock is the only thing stopping two runs overlapping, and the default 5 minutes expires
    // before the job's own 8-minute budget — releasing mid-run, so the next tick starts a second
    // pass over the same accounts.
    expect(gdprStripeScrubJob.options.lockExpiration).toBeGreaterThan(8 * 60);
  });
});
