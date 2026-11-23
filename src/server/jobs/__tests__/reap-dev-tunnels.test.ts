import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reap-dev-tunnels periodic job: the wiring around `reapExpiredDevTunnels`, whose own
 * reap/skip/guard logic is covered in dev-tunnel.service.test.ts.
 */

const { mockReap, mockRecordRun } = vi.hoisted(() => ({
  mockReap: vi.fn(),
  mockRecordRun: vi.fn(),
}));

vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  reapExpiredDevTunnels: (...a: unknown[]) => mockReap(...a),
}));
vi.mock('~/server/prom/dev-tunnel.metrics', () => ({
  recordDevTunnelReaperRun: (...a: unknown[]) => mockRecordRun(...a),
}));
// createJob wraps the handler in metadata/lock machinery we don't need here —
// stub it to hand back the bare handler (mirrors the sibling block-job tests).
vi.mock('../job', () => ({
  createJob: (_name: string, _cron: string, fn: () => unknown) => fn,
}));

import { reapDevTunnelsJob } from '../reap-dev-tunnels';

// After the createJob stub, the export is the bare async handler.
const runJob = reapDevTunnelsJob as unknown as () => Promise<{
  swept: number;
  reaped: number;
  skipped: number;
  listOk: boolean;
  status?: number;
  error?: boolean;
}>;

beforeEach(() => {
  mockReap.mockReset();
  mockRecordRun.mockReset();
});

describe('reapDevTunnelsJob', () => {
  it('invokes the reaper and returns its result', async () => {
    mockReap.mockResolvedValue({ swept: 3, reaped: 1, skipped: 0, listOk: true });

    const result = await runJob();

    expect(mockReap).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ swept: 3, reaped: 1, skipped: 0, listOk: true });
    expect(mockRecordRun).toHaveBeenCalledWith('ok');
  });

  it('surfaces a LIST failure in its result (not a silent no-op)', async () => {
    mockReap.mockResolvedValue({ swept: 0, reaped: 0, skipped: 0, listOk: false, status: 403 });

    const result = await runJob();

    expect(result).toMatchObject({ listOk: false, status: 403 });
    expect(mockRecordRun).toHaveBeenCalledWith('list_failed');
    expect(mockRecordRun).not.toHaveBeenCalledWith('ok');
  });

  it('swallows a thrown reaper failure and returns a benign result', async () => {
    mockReap.mockRejectedValue(new Error('k8s API / TLS'));

    // Must NOT throw (a reaper failure can never crash the runner).
    const result = await runJob();

    expect(result).toMatchObject({ swept: 0, reaped: 0, skipped: 0, listOk: false, error: true });
    expect(mockRecordRun).toHaveBeenCalledWith('error');
  });
});
