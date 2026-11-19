import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  set: vi.fn(async () => 'OK'),
  get: vi.fn(),
  del: vi.fn(),
  eval: vi.fn(async (_script: string, _opts: unknown) => 1),
}));
vi.mock('../../redis', () => ({ getSysRedis: () => redis }));
const exportUnsent = vi.hoisted(() => vi.fn());
vi.mock('../backlog-import', () => ({ exportUnsent, exportState: vi.fn() }));

const { startExport } = await import('../cases.service');

const renewals = () =>
  redis.eval.mock.calls.filter(([script]) => String(script).includes("'expire'")).length;

beforeEach(() => {
  vi.useFakeTimers();
  redis.eval.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('startExport', () => {
  it('renews its run lock while the export runs, and stops once it ends', async () => {
    let finish!: (rows: unknown[]) => void;
    exportUnsent.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const running = startExport('backlog-1', 7);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(renewals()).toBe(3);

    finish([]);
    await running;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(renewals()).toBe(3);
  });
});
