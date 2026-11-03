import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { bluePaidAccessDetection } from '~/server/jobs/blue-buzz-paid-access-detection';
import { RUN_JOBS_ROUTE, jobsArrayEntries } from '~/server/jobs/__tests__/run-jobs-array';
import { RUN_INTERVAL_HOURS } from '../detect';

const JOB_FILE = path.resolve(__dirname, '../../../jobs/blue-buzz-paid-access-detection.ts');

describe('the blue-buzz paid-access detection job', () => {
  it('fires once a day, matching the interval the run files new activity for', () => {
    expect(bluePaidAccessDetection.cron).toBe('30 7 * * *');
    const fields = bluePaidAccessDetection.cron.trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    const [minute, hour, dom, month, dow] = fields;
    expect(minute).toMatch(/^[0-5]?\d$/);
    expect(hour).toMatch(/^([01]?\d|2[0-3])$/);
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
    expect(RUN_INTERVAL_HOURS).toBe(24);
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

  it('reads its thresholds from the environment', () => {
    const source = readFileSync(JOB_FILE, 'utf8');
    expect(source.length).toBeGreaterThan(500);
    expect(source).toContain('thresholds: ringThresholdsFromEnv(env)');
  });
});
