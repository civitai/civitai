import { describe, expect, it } from 'vitest';
import {
  CREATOR_MILESTONE_GRANT_CRON,
  nextDailyCronRun,
} from '~/shared/constants/creator-journey.constants';

describe('nextDailyCronRun', () => {
  it('is later today before the run, tomorrow at or after it', () => {
    const at = (iso: string) =>
      nextDailyCronRun(CREATOR_MILESTONE_GRANT_CRON, new Date(iso)).toISOString();
    expect(at('2026-10-11T01:19:59.000Z')).toBe('2026-10-11T01:20:00.000Z');
    expect(at('2026-10-11T01:20:00.000Z')).toBe('2026-10-12T01:20:00.000Z');
    expect(at('2026-10-31T23:00:00.000Z')).toBe('2026-11-01T01:20:00.000Z');
  });

  // The page derives its time from the job's own cron; a schedule it cannot read must not guess.
  it('refuses a schedule that is not once a day', () => {
    expect(() => nextDailyCronRun('*/15 * * * *', new Date())).toThrow('Not a daily cron');
    expect(() => nextDailyCronRun('20 1 * * 1', new Date())).toThrow('Not a daily cron');
  });

  it('reads the grant job schedule', () => {
    expect(() => nextDailyCronRun(CREATOR_MILESTONE_GRANT_CRON, new Date())).not.toThrow();
  });
});
