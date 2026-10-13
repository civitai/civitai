import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setIngestionGaugeSharedStore } from '~/server/prom/client';
import {
  createIngestionGaugeStore,
  installIngestionGaugeStore,
} from '~/server/prom/ingestion-gauge-store';

const redis = () => ({ get: vi.fn(), set: vi.fn() });

beforeEach(() => {
  vi.mocked(setIngestionGaugeSharedStore).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ingestion gauge store', () => {
  it('reads and writes one sys key per version, and elects with SET NX PX on a lock key under it', async () => {
    const r = redis();
    r.get.mockResolvedValue('{"computedAt":1}');
    r.set
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('OK');
    const store = createIngestionGaugeStore(r as never);

    expect(await store.read('v1a')).toBe('{"computedAt":1}');
    expect(await store.tryLock('v1a', 25_000)).toBe(true);
    expect(await store.tryLock('v1a', 25_000)).toBe(false);
    await store.write('v1a', '{"computedAt":2}', 600_000);
    expect(await store.tryLock('v2b', 25_000)).toBe(true);

    expect(r.get).toHaveBeenCalledWith('system:image-ingestion-gauges:v1a');
    expect(r.set.mock.calls).toEqual([
      ['system:image-ingestion-gauges:v1a:lock', '1', { NX: true, PX: 25_000 }],
      ['system:image-ingestion-gauges:v1a:lock', '1', { NX: true, PX: 25_000 }],
      ['system:image-ingestion-gauges:v1a', '{"computedAt":2}', { PX: 600_000 }],
      ['system:image-ingestion-gauges:v2b:lock', '1', { NX: true, PX: 25_000 }],
    ]);
  });

  it('a call that never settles rejects at the sys read deadline instead of parking the refresh', async () => {
    vi.useFakeTimers();
    const r = redis();
    r.get.mockReturnValue(new Promise(() => undefined));
    const outcome = createIngestionGaugeStore(r as never)
      .read('v1a')
      .then(
        () => 'resolved',
        (e: Error) => `rejected: ${e.message}`
      );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await Promise.race([outcome, Promise.resolve('still pending')])).toMatch(
      /^rejected: .*timed out/
    );
  });

  it.each([
    [{}, true],
    [{ IS_PREVIEW: 'true' }, false],
    [{ DATABASE_ENVIRONMENT: 'non-production' }, false],
    [{ IS_PREVIEW: 'true', DATABASE_ENVIRONMENT: 'production' }, true],
  ])('installs only on the production database: %j -> %s', (env, installed) => {
    expect(installIngestionGaugeStore(env as NodeJS.ProcessEnv)).toBe(installed);
    expect(vi.mocked(setIngestionGaugeSharedStore)).toHaveBeenCalledTimes(installed ? 1 : 0);
  });
});
