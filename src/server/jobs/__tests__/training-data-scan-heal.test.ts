import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/training-data-scan.service', () => ({
  healStalledTrainingDataScans: vi.fn(),
}));

import { trainingDataScanHealJob } from '~/server/jobs/training-data-scan-heal';

// A run copies two waves of up to about 12 minutes each; a lock that ran out sooner, or went with a
// dropped scheduler connection, would let runs overlap.
describe('training-data-scan-heal', () => {
  it('holds its lock longer than a run, through a scheduler disconnect', () => {
    const job = trainingDataScanHealJob as unknown as {
      cron: string;
      options: { lockExpiration: number; keepLockOnDisconnect: boolean };
    };
    expect(job.options.keepLockOnDisconnect).toBe(true);
    expect(job.options.lockExpiration).toBeGreaterThanOrEqual(30 * 60);
  });

  // The self-heal is the only way back for a zip whose scan was lost; unscheduled, it never runs.
  it('is scheduled by the job runner', () => {
    const runner = readFileSync(
      join(process.cwd(), 'src/pages/api/webhooks/run-jobs/[[...run]].ts'),
      'utf8'
    );
    expect(runner).toMatch(/^\s+trainingDataScanHealJob,$/m);
  });
});
