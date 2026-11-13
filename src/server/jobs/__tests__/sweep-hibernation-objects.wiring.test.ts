import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sweepHibernationObjectsJob } from '~/server/jobs/sweep-hibernation-objects';

/**
 * The entry in the `jobs` array IS the scheduling: without it the sweep never runs, and a failed
 * account-deletion step is never finished. Read as source, because importing the route pulls in
 * every job in the application. Its behaviour is in `delete-user-sleeping-apps.test.ts`.
 */
const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);

describe('sweep-hibernation-objects — wiring', () => {
  it('is registered in the jobs array the scheduler reads, hourly', () => {
    const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
    const start = source.indexOf('export const jobs: Job[] = [');
    expect(start).toBeGreaterThan(-1);
    const array = source.slice(start, source.indexOf('];', start));
    expect(array).toContain('sweepHibernationObjectsJob');
    expect(source).toContain("from '~/server/jobs/sweep-hibernation-objects'");
    expect(sweepHibernationObjectsJob.name).toBe('sweep-hibernation-objects');
    expect(sweepHibernationObjectsJob.cron).toBe('23 * * * *');
  });
});
