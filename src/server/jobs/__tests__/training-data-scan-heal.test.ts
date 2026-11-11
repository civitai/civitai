import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/training-data-scan.service', () => ({
  healStalledTrainingDataScans: vi.fn(),
}));

import { trainingDataScanHealJob } from '~/server/jobs/training-data-scan-heal';

// A run copies two waves of up to about 12 minutes each; a lock that ran out sooner, or went with a
// dropped scheduler connection, would let the next run re-claim zips this one has not started.
describe('training-data-scan-heal', () => {
  it('holds its lock longer than a run, through a scheduler disconnect', () => {
    const job = trainingDataScanHealJob as unknown as {
      cron: string;
      options: { lockExpiration: number; keepLockOnDisconnect: boolean };
    };
    expect(job.cron).toBe('*/15 * * * *');
    expect(job.options.keepLockOnDisconnect).toBe(true);
    expect(job.options.lockExpiration).toBeGreaterThanOrEqual(2 * 12 * 60);
  });
});
