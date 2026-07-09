import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the reap-dev-tunnels periodic job — the wiring around
 * `reapExpiredDevTunnels` (whose own reap/skip/guard logic is covered in
 * dev-tunnel.service.test.ts). Asserts the job:
 *  - invokes the reaper and passes its result through,
 *  - is a silent no-op when there is nothing to sweep (the DARK common case),
 *  - logs a summary + counts `ok` only when it actually did something,
 *  - surfaces a LIST failure (listOk:false) as a DISTINCT error + `list_failed`
 *    metric (not a silent no-op),
 *  - swallows a thrown reaper failure (logs + `error` metric + benign result) so
 *    a k8s/TLS blip can NEVER crash the runner.
 */

const { mockReap, mockLogToAxiom, mockRecordRun } = vi.hoisted(() => ({
  mockReap: vi.fn(),
  mockLogToAxiom: vi.fn(() => Promise.resolve(undefined)),
  mockRecordRun: vi.fn(),
}));

vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  reapExpiredDevTunnels: (...a: unknown[]) => mockReap(...a),
}));
vi.mock('~/server/prom/dev-tunnel.metrics', () => ({
  recordDevTunnelReaperRun: (...a: unknown[]) => mockRecordRun(...a),
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
  skipped: number;
  listOk: boolean;
  status?: number;
  error?: boolean;
}>;

beforeEach(() => {
  mockReap.mockReset();
  mockLogToAxiom.mockReset();
  mockLogToAxiom.mockReturnValue(Promise.resolve(undefined));
  mockRecordRun.mockReset();
});

describe('reapDevTunnelsJob', () => {
  it('invokes the reaper and returns its result, counting `ok`', async () => {
    mockReap.mockResolvedValue({ swept: 3, reaped: 1, skipped: 0, listOk: true });

    const result = await runJob();

    expect(mockReap).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ swept: 3, reaped: 1, skipped: 0, listOk: true });
    expect(mockRecordRun).toHaveBeenCalledWith('ok');
  });

  it('is a silent no-op when there is nothing to sweep (dark case)', async () => {
    mockReap.mockResolvedValue({ swept: 0, reaped: 0, skipped: 0, listOk: true });

    const result = await runJob();

    expect(result).toEqual({ swept: 0, reaped: 0, skipped: 0, listOk: true });
    expect(mockRecordRun).toHaveBeenCalledWith('ok');
    // Nothing swept → no summary log emitted (but the `ok` metric still ticks).
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('logs a summary (incl. skipped) only when the sweep did something', async () => {
    mockReap.mockResolvedValue({ swept: 2, reaped: 1, skipped: 1, listOk: true });

    await runJob();

    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reap-dev-tunnels', swept: 2, reaped: 1, skipped: 1 }),
      'webhooks'
    );
  });

  it('surfaces a LIST failure as a distinct error + `list_failed` metric (not a silent no-op)', async () => {
    mockReap.mockResolvedValue({ swept: 0, reaped: 0, skipped: 0, listOk: false, status: 403 });

    const result = await runJob();

    expect(result).toMatchObject({ listOk: false, status: 403 });
    expect(mockRecordRun).toHaveBeenCalledWith('list_failed');
    expect(mockRecordRun).not.toHaveBeenCalledWith('ok');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reap-dev-tunnels', level: 'error', status: 403 }),
      'webhooks'
    );
  });

  it('swallows a thrown reaper failure — logs, counts `error`, returns a benign result', async () => {
    mockReap.mockRejectedValue(new Error('k8s API / TLS'));

    // Must NOT throw (a reaper failure can never crash the runner).
    const result = await runJob();

    expect(result).toMatchObject({ swept: 0, reaped: 0, skipped: 0, listOk: false, error: true });
    expect(mockRecordRun).toHaveBeenCalledWith('error');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reap-dev-tunnels',
        level: 'error',
        message: 'k8s API / TLS',
      }),
      'webhooks'
    );
  });

  it('does not reject even if the error logger itself throws', async () => {
    mockReap.mockRejectedValue(new Error('boom'));
    mockLogToAxiom.mockReturnValue(Promise.reject(new Error('axiom down')));

    // The catch attaches `.catch(() => undefined)` to the log call, so a logging
    // failure is absorbed too — the handler still resolves benignly.
    await expect(runJob()).resolves.toMatchObject({ listOk: false, error: true });
  });
});
