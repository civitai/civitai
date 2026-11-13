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
  it('registers a store over sysRedis, keyed by the Flipt environment, with a 24h TTL', async () => {
    registerFliptSnapshotStore();
    const store = registered.store!;
    expect(store).toBeDefined();

    redisMock.sysRedis.get.mockResolvedValue(null);
    await store.save({ savedAt: 5_000, etag: '"e"', data: { flags: [] } }, true);

    const writes = redisMock.sysRedis.set.mock.calls.map(([key, , opts]: unknown[]) => [key, opts]);
    expect(writes).toEqual([
      ['system:flipt:snapshot:civitai-app', { PX: 86_400_000 }],
      ['system:flipt:snapshot:civitai-app:meta', { PX: 86_400_000 }],
    ]);
  });

  it('reads the stored snapshot back through the sysRedis read deadline', async () => {
    registerFliptSnapshotStore();
    redisMock.sysRedis.get.mockResolvedValue(
      JSON.stringify({ savedAt: 5_000, etag: null, data: { flags: [] } })
    );

    expect(await registered.store!.load()).toEqual({
      savedAt: 5_000,
      etag: null,
      data: { flags: [] },
    });
    expect(redisMock.sysRedis.get).toHaveBeenCalledWith('system:flipt:snapshot:civitai-app');
    expect(redisMock.withSysReadDeadline).toHaveBeenCalledTimes(1);
  });

  it('a non-default environment gets its own key', async () => {
    process.env.FLIPT_ENVIRONMENT = 'spoke-env';
    registerFliptSnapshotStore();
    redisMock.sysRedis.get.mockResolvedValue(null);
    await registered.store!.load();
    expect(redisMock.sysRedis.get).toHaveBeenCalledWith('system:flipt:snapshot:spoke-env');
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
