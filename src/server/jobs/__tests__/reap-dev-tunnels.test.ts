import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the reap-dev-tunnels periodic job — the wiring around
 * `reapExpiredDevTunnels` (whose own reap logic is covered in
 * dev-tunnel.service.test.ts). Asserts the job:
 *  - invokes the reaper and passes its result through,
 *  - is a silent no-op when there is nothing to sweep (the DARK common case),
 *  - logs a summary only when it actually swept/reaped something,
 *  - swallows a reaper failure (logs + returns a benign result) so a k8s/TLS
 *    blip can NEVER crash the runner.
 */

const { mockReap, mockLogToAxiom } = vi.hoisted(() => ({
  mockReap: vi.fn(),
  mockLogToAxiom: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  reapExpiredDevTunnels: (...a: unknown[]) => mockReap(...a),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...a: unknown[]) => mockLogToAxiom(...a),
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
  error?: boolean;
}>;

beforeEach(() => {
  mockReap.mockReset();
  mockLogToAxiom.mockReset();
  mockLogToAxiom.mockReturnValue(Promise.resolve(undefined));
});

describe('reapDevTunnelsJob', () => {
  it('invokes the reaper and returns its result', async () => {
    mockReap.mockResolvedValue({ swept: 3, reaped: 1 });

    const result = await runJob();

    expect(mockReap).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ swept: 3, reaped: 1 });
  });

  it('is a silent no-op when there is nothing to sweep (dark case)', async () => {
    mockReap.mockResolvedValue({ swept: 0, reaped: 0 });

    const result = await runJob();

    expect(result).toEqual({ swept: 0, reaped: 0 });
    // Nothing swept → no summary log emitted.
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('logs a summary only when it actually swept/reaped something', async () => {
    mockReap.mockResolvedValue({ swept: 2, reaped: 2 });

    await runJob();

    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reap-dev-tunnels', swept: 2, reaped: 2 }),
      'webhooks'
    );
  });

  it('swallows a reaper failure — logs the error and returns a benign result', async () => {
    mockReap.mockRejectedValue(new Error('k8s API 403 / TLS'));

    // Must NOT throw (a reaper failure can never crash the runner).
    const result = await runJob();

    expect(result).toEqual({ swept: 0, reaped: 0, error: true });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reap-dev-tunnels',
        level: 'error',
        message: 'k8s API 403 / TLS',
      }),
      'webhooks'
    );
  });

  it('does not reject even if the error logger itself throws', async () => {
    mockReap.mockRejectedValue(new Error('boom'));
    mockLogToAxiom.mockReturnValue(Promise.reject(new Error('axiom down')));

    // The catch attaches `.catch(() => undefined)` to the log call, so a logging
    // failure is absorbed too — the handler still resolves benignly.
    await expect(runJob()).resolves.toEqual({ swept: 0, reaped: 0, error: true });
  });
});
