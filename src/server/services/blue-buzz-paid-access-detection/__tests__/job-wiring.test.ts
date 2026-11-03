import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  bluePaidAccessDetection,
  runBluePaidAccessJob,
} from '~/server/jobs/blue-buzz-paid-access-detection';
import { RUN_JOBS_ROUTE, jobsArrayEntries } from '~/server/jobs/__tests__/run-jobs-array';
import { RUN_INTERVAL_HOURS, type RingThresholds } from '../detect';
import type { RunDeps, RunResult } from '../run';

/** How many times a day a five-field cron fires. Only `*` and a single number are understood; any
 *  other field shape (lists, ranges, steps) is NaN, so the assertion below fails on it. */
function firingsPerDay(cron: string) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return NaN;
  const [minute, hour, ...days] = fields;
  if (days.some((f) => f !== '*')) return NaN;
  const count = (f: string, all: number) => (f === '*' ? all : /^\d+$/.test(f) ? 1 : NaN);
  return count(minute, 60) * count(hour, 24);
}

describe('the blue-buzz paid-access detection job', () => {
  it('fires once a day, matching the interval the run files new activity for', () => {
    expect(firingsPerDay(bluePaidAccessDetection.cron)).toBe(1);
    expect(RUN_INTERVAL_HOURS).toBe(24 / firingsPerDay(bluePaidAccessDetection.cron));
  });

  it('is in the `jobs` array the route dispatches on', () => {
    const entries = jobsArrayEntries();
    expect(entries.length).toBeGreaterThan(50);
    expect(entries).toContain('bluePaidAccessDetection');
    expect(readFileSync(RUN_JOBS_ROUTE, 'utf8')).toContain(
      "from '~/server/jobs/blue-buzz-paid-access-detection'"
    );
    expect(bluePaidAccessDetection.name).toBe('blue-buzz-paid-access-detection');
  });

  it('runs with the thresholds the environment sets', async () => {
    // Distinct from the defaults and from each other, so a swapped or defaulted field shows.
    const run = vi.fn<(deps: RunDeps) => Promise<RunResult>>(async () => ({
      pairs: 0,
      rings: 0,
      reported: 0,
    }));
    await runBluePaidAccessJob(
      {
        BLUE_PAID_ACCESS_RING_WINDOW_DAYS: 11,
        BLUE_PAID_ACCESS_RING_MIN_BUYERS: 6,
        BLUE_PAID_ACCESS_RING_MIN_SHARE_PCT: 70,
      },
      run
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].thresholds).toEqual<RingThresholds>({
      windowDays: 11,
      minBuyers: 6,
      minSharePct: 70,
    });
  });
});
