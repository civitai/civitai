import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSweep, mockAccept, mockIsFlipt } = vi.hoisted(() => ({
  mockSweep: vi.fn().mockResolvedValue({ flagged: 0 }),
  mockAccept: vi.fn().mockResolvedValue({ accepted: 0 }),
  mockIsFlipt: vi.fn(),
}));

vi.mock('~/server/services/minor-hash.service', () => ({
  sweepMinorHashMatches: mockSweep,
  acceptExpiredMinorAutoFlags: mockAccept,
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
  FLIPT_FEATURE_FLAGS: { MINOR_HASH_AUTO_FLAG: 'minor-hash-auto-flag' },
}));
// createJob wraps the handler in cron/lock machinery; the flag gate is what
// this file is about, so run the handler directly.
vi.mock('../job', () => ({
  createJob: (_name: string, _cron: string, fn: () => Promise<unknown>) => ({ run: fn }),
}));

import { minorHashSweep } from '../minor-hash-sweep';

const run = () => (minorHashSweep as unknown as { run: () => Promise<unknown> }).run();

beforeEach(() => {
  vi.clearAllMocks();
  mockSweep.mockResolvedValue({ flagged: 0 });
  mockAccept.mockResolvedValue({ accepted: 0 });
});

describe('minorHashSweep job — kill switch', () => {
  it('does not sweep while the flag is off', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await run();

    expect(mockSweep).not.toHaveBeenCalled();
    expect(mockAccept).not.toHaveBeenCalled();
  });

  // Default-off matters: isFlipt returns false for an unknown flag or an
  // unreachable Flipt, so the job ships dormant rather than auto-flagging on
  // its first nightly run after deploy.
  it('stays dormant when Flipt is unreachable', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await run();

    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('sweeps for real, not as a dry run, once the flag is on', async () => {
    mockIsFlipt.mockResolvedValue(true);

    await run();

    expect(mockSweep).toHaveBeenCalledWith({ dryRun: false, limit: 500 });
    expect(mockAccept).toHaveBeenCalledWith({ dryRun: false, limit: 500 });
  });

  it('merges the sweep and accept results into a single report', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockSweep.mockResolvedValue({ flagged: 3 });
    mockAccept.mockResolvedValue({ accepted: 4 });

    const result = await run();

    expect(result).toEqual({ flagged: 3, accepted: 4 });
  });

  it('gates on the shared minor-hash flag', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await run();

    expect(mockIsFlipt).toHaveBeenCalledWith('minor-hash-auto-flag');
  });
});
