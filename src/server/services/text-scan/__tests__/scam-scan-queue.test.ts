import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { createScamScanQueue } from '~/server/services/text-scan/scam-scan-queue';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => vi.clearAllMocks());

describe('queueScamScan', () => {
  it('runs at most `concurrency` scans at once and drains the rest', async () => {
    const releases: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const scan = vi.fn(
      () =>
        new Promise<{ status: 'skipped'; reason: 'off' }>((resolve) => {
          running++;
          peak = Math.max(peak, running);
          releases.push(() => {
            running--;
            resolve({ status: 'skipped', reason: 'off' });
          });
        })
    );
    const queue = createScamScanQueue({ concurrency: 2, maxPending: 10, scan });
    for (let id = 1; id <= 5; id++) queue({ entityType: 'Comment', entityId: id });
    await flush();
    expect(scan).toHaveBeenCalledTimes(2);

    for (let round = 0; round < 5 && releases.length; round++) {
      releases.splice(0).forEach((release) => release());
      await flush();
    }
    expect(scan).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  it('drops and logs past maxPending instead of growing without bound', async () => {
    // Never settles on purpose: each is a pending promise the test abandons, not a loop.
    const scan = vi.fn(() => new Promise<never>(() => undefined));
    const queue = createScamScanQueue({ concurrency: 1, maxPending: 2, scan });
    for (let id = 1; id <= 5; id++) queue({ entityType: 'Comment', entityId: id });
    await flush();
    expect(scan).toHaveBeenCalledTimes(1);
    const dropped = vi
      .mocked(loggingMock.logToAxiom)
      .mock.calls.map(([event]) => event as { message?: string; entityId?: number })
      .filter((event) => event.message === 'scam scan queue full, dropped')
      .map((event) => event.entityId);
    expect(dropped).toEqual([3, 4, 5]);
  });

  it('logs a scan that throws and keeps going', async () => {
    const scan = vi
      .fn()
      .mockRejectedValueOnce(new Error('flipt down'))
      .mockResolvedValue({ status: 'failed' });
    const queue = createScamScanQueue({ concurrency: 1, maxPending: 10, scan });
    queue({ entityType: 'Comment', entityId: 1 });
    queue({ entityType: 'Comment', entityId: 2 });
    await flush();
    await flush();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'text-scan',
        type: 'error',
        message: 'background scan threw',
        entityId: 1,
      })
    );
  });
});
