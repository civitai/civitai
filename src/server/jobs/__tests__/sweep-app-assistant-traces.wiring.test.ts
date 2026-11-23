import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sweepAppAssistantTracesJob } from '~/server/jobs/sweep-app-assistant-traces';

/**
 * The entry in the `jobs` array IS the scheduling: without it an account deletion that could not
 * delete a frozen transcript is never finished. Read as source, because importing the route pulls in
 * every job in the application. Its behaviour is in `submission-trace.service.test.ts`.
 */
const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);

describe('sweep-app-assistant-traces — wiring', () => {
  it('is registered in the jobs array the scheduler reads, hourly', () => {
    const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
    const start = source.indexOf('export const jobs: Job[] = [');
    expect(start).toBeGreaterThan(-1);
    const array = source.slice(start, source.indexOf('];', start));
    expect(array).toContain('sweepAppAssistantTracesJob');
    expect(source).toContain("from '~/server/jobs/sweep-app-assistant-traces'");
    expect(sweepAppAssistantTracesJob.name).toBe('sweep-app-assistant-traces');
    expect(sweepAppAssistantTracesJob.cron).toBe('41 * * * *');
  });
});
