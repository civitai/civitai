import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CREATOR_MILESTONE_GRANT_CRON,
  nextDailyCronRun,
} from '~/shared/constants/creator-journey.constants';

describe('nextDailyCronRun', () => {
  // Not UTC, so a run computed in local time lands somewhere else.
  beforeAll(() => {
    vi.stubEnv('TZ', 'America/Denver');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('is later today before the run, tomorrow at or after it, in UTC', () => {
    expect(new Date('2026-10-11T05:00:00Z').getDate()).toBe(10);
    const at = (iso: string) =>
      nextDailyCronRun(CREATOR_MILESTONE_GRANT_CRON, new Date(iso)).toISOString();
    expect(at('2026-10-11T01:19:59.000Z')).toBe('2026-10-11T01:20:00.000Z');
    expect(at('2026-10-11T01:20:00.000Z')).toBe('2026-10-12T01:20:00.000Z');
    expect(at('2026-10-31T23:00:00.000Z')).toBe('2026-11-01T01:20:00.000Z');
    // Still the 10th in Denver, already the 11th in UTC.
    expect(at('2026-10-11T05:00:00.000Z')).toBe('2026-10-12T01:20:00.000Z');
  });

  // The page derives its time from the job's own cron; a schedule it cannot read must not guess.
  it('refuses a schedule that is not once a day', () => {
    expect(() => nextDailyCronRun('*/15 * * * *', new Date())).toThrow('Not a daily cron');
    expect(() => nextDailyCronRun('20 1 * * 1', new Date())).toThrow('Not a daily cron');
  });

  // The journey page's unlock time is only right while the job runs on this constant.
  it('is the schedule the grant job registers with', () => {
    const job = readFileSync(
      new URL('../../../server/jobs/grant-creator-milestones.ts', import.meta.url),
      'utf8'
    );
    expect(job).toMatch(
      /createJob\(\s*'grant-creator-milestones',\s*CREATOR_MILESTONE_GRANT_CRON,\s*async/
    );
  });
});
