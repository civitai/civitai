import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FliptSnapshotStore } from '@civitai/flipt';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { resetSharedMocks } from '~/__tests__/mocks';

const registered = vi.hoisted(() => ({ store: undefined as FliptSnapshotStore | undefined }));
vi.mock('~/server/flipt/client', () => ({
  setFliptSnapshotStore: (store: FliptSnapshotStore | undefined) => {
    registered.store = store;
  },
}));

import { registerFliptSnapshotStore } from '~/server/flipt/snapshot-store';

beforeEach(() => {
  resetSharedMocks();
  registered.store = undefined;
  // Opt in (24h): the store is DARK by default, pinned by the last test.
  process.env.FLIPT_SNAPSHOT_MAX_AGE_MS = '86400000';
  delete process.env.FLIPT_ENVIRONMENT;
});

describe('registerFliptSnapshotStore', () => {
  it('registers a store on the cache cluster, keyed by the Flipt environment, with a 24h TTL', async () => {
    registerFliptSnapshotStore();
    const store = registered.store!;
    expect(store).toBeDefined();

    redisMock.redis.get.mockResolvedValue(null);
    await store.save({ savedAt: 5_000, etag: '"e"', data: { flags: [] } }, true);

    const writes = redisMock.redis.set.mock.calls.map(([key, , opts]: unknown[]) => [key, opts]);
    expect(writes).toEqual([
      ['system:flipt:snapshot:civitai-app', { PX: 86_400_000 }],
      ['system:flipt:snapshot:civitai-app:meta', { PX: 86_400_000 }],
    ]);
  });

  it('reads the stored snapshot back from the cache cluster', async () => {
    registerFliptSnapshotStore();
    redisMock.redis.get.mockResolvedValue(
      JSON.stringify({ savedAt: 5_000, etag: null, data: { flags: [] } })
    );

    expect(await registered.store!.load()).toEqual({
      savedAt: 5_000,
      etag: null,
      data: { flags: [] },
    });
    expect(redisMock.redis.get).toHaveBeenCalledWith('system:flipt:snapshot:civitai-app');
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
  });

  it('gives up on a read that does not answer after one second', async () => {
    vi.useFakeTimers();
    try {
      registerFliptSnapshotStore();
      redisMock.redis.get.mockImplementation((() => new Promise(() => undefined)) as never);

      let settled = false;
      const load = registered.store!.load().finally(() => {
        settled = true;
      });
      load.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(load).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  // Invariant guard: save() reads the meta key through the same kv.get, so a stalled cluster
  // bounds it with the same deadline as load().
  it("save()'s meta read also gives up after one second", async () => {
    vi.useFakeTimers();
    try {
      registerFliptSnapshotStore();
      redisMock.redis.get.mockImplementation((() => new Promise(() => undefined)) as never);

      const save = registered.store!.save(
        { savedAt: 5_000, etag: '"e"', data: { flags: [] } },
        true
      );
      save.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(save).rejects.toThrow();
      expect(redisMock.redis.get).toHaveBeenCalledWith('system:flipt:snapshot:civitai-app:meta');
      expect(redisMock.redis.set).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-default environment gets its own key', async () => {
    process.env.FLIPT_ENVIRONMENT = 'spoke-env';
    registerFliptSnapshotStore();
    redisMock.redis.get.mockResolvedValue(null);
    await registered.store!.load();
    expect(redisMock.redis.get).toHaveBeenCalledWith('system:flipt:snapshot:spoke-env');
  });

  it('FLIPT_SNAPSHOT_MAX_AGE_MS=0 registers nothing (no reads, no writes)', () => {
    process.env.FLIPT_SNAPSHOT_MAX_AGE_MS = '0';
    registerFliptSnapshotStore();
    expect(registered.store).toBeUndefined();
  });

  it('is DARK by default: FLIPT_SNAPSHOT_MAX_AGE_MS unset registers nothing', () => {
    delete process.env.FLIPT_SNAPSHOT_MAX_AGE_MS;
    registerFliptSnapshotStore();
    expect(registered.store).toBeUndefined();
  });
});
