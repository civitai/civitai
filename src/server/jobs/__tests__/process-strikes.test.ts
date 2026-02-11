import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to define mocks that will be available in vi.mock factories
const { mockExpireStrikes, mockProcessTimedUnmutes } = vi.hoisted(() => ({
  mockExpireStrikes: vi.fn(),
  mockProcessTimedUnmutes: vi.fn(),
}));

// Mock the strike service
vi.mock('~/server/services/strike.service', () => ({
  expireStrikes: mockExpireStrikes,
  processTimedUnmutes: mockProcessTimedUnmutes,
}));

// Mock logging
vi.mock('~/utils/logging', () => ({
  createLogger: () => vi.fn(),
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(),
}));

// Mock createJob to return a testable object
vi.mock('~/server/jobs/job', () => ({
  createJob: (_name: string, _cron: string, fn: any) => ({
    name: _name,
    cron: _cron,
    options: { shouldWait: false, lockExpiration: 0 },
    run: (opts?: { req?: any }) => ({
      result: fn({ status: 'running', on: vi.fn(), checkIfCanceled: vi.fn(), req: opts?.req }),
      cancel: vi.fn(),
    }),
  }),
}));

// Import after mocks
import { expireStrikesJob, processTimedUnmutesJob } from '~/server/jobs/process-strikes';

describe('process-strikes jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('expireStrikesJob', () => {
    it('calls expireStrikes() and returns result', async () => {
      mockExpireStrikes.mockResolvedValue({ expiredCount: 3 });

      const result = await expireStrikesJob.run().result;

      expect(mockExpireStrikes).toHaveBeenCalledOnce();
      expect(result).toEqual({ expiredCount: 3 });
    });

    it('returns zero count when nothing to expire', async () => {
      mockExpireStrikes.mockResolvedValue({ expiredCount: 0 });

      const result = await expireStrikesJob.run().result;

      expect(result).toEqual({ expiredCount: 0 });
    });
  });

  describe('processTimedUnmutesJob', () => {
    it('calls processTimedUnmutes() and returns result', async () => {
      mockProcessTimedUnmutes.mockResolvedValue({ unmutedCount: 2 });

      const result = await processTimedUnmutesJob.run().result;

      expect(mockProcessTimedUnmutes).toHaveBeenCalledOnce();
      expect(result).toEqual({ unmutedCount: 2 });
    });

    it('returns zero count when no users to unmute', async () => {
      mockProcessTimedUnmutes.mockResolvedValue({ unmutedCount: 0 });

      const result = await processTimedUnmutesJob.run().result;

      expect(result).toEqual({ unmutedCount: 0 });
    });
  });
});
