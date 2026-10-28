import { describe, expect, it } from 'vitest';
import {
  LOCK_TTL_SECONDS,
  SNAPSHOT_TTL_SECONDS,
  createRedisSnapshotStore,
} from '../tickets/snapshot-store';
import type { Snapshot } from '$lib/tickets/snapshot';

const snapshot: Snapshot = {
  tickets: [
    {
      id: '1',
      subject: 's',
      status: 2,
      cfFeature: null,
      tags: [],
      createdAt: null,
      updatedAt: null,
    },
  ],
  syncedAt: 1,
  attemptedAt: 2,
  fullAt: 3,
  needsFull: false,
  readWarnings: [],
  routerFailed: false,
  lastError: null,
};

/** The three commands the store uses, with SET's NX semantics. */
function fakeRedis() {
  const data = new Map<string, string>();
  const ttl = new Map<string, number | undefined>();
  const client = {
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string, options?: { EX?: number; NX?: boolean }) => {
      if (options?.NX && data.has(key)) return null;
      data.set(key, value);
      ttl.set(key, options?.EX);
      return 'OK';
    },
    del: async (key: string) => (data.delete(key) ? 1 : 0),
  };
  return { client, data, ttl };
}

const make = (r = fakeRedis()) => ({
  ...r,
  store: createRedisSnapshotStore(() => r.client as never),
});

describe('snapshot store', () => {
  it('round-trips a snapshot and expires it eventually', async () => {
    const { store, ttl } = make();
    await store.write(snapshot);
    expect(await store.read()).toEqual(snapshot);
    expect([...ttl.values()]).toEqual([SNAPSHOT_TTL_SECONDS]);
  });

  it('reads nothing when none was written', async () => {
    expect(await make().store.read()).toBeNull();
  });

  it('treats a corrupt or foreign value as no snapshot, so it is rebuilt', async () => {
    const { store, data } = make();
    await store.write(snapshot);
    const key = [...data.keys()][0];
    data.set(key, '{not json');
    expect(await store.read()).toBeNull();
    data.set(key, JSON.stringify({ tickets: 'nope' }));
    expect(await store.read()).toBeNull();
  });

  it('lets one holder take the lock at a time, with an expiry', async () => {
    const { store, ttl } = make();
    expect(await store.lock('a')).toBe(true);
    expect(await store.lock('b')).toBe(false);
    expect([...ttl.values()]).toContain(LOCK_TTL_SECONDS);
  });

  it('releases the lock only for its holder', async () => {
    const { store } = make();
    await store.lock('a');
    await store.unlock('b');
    expect(await store.lock('c')).toBe(false);
    await store.unlock('a');
    expect(await store.lock('c')).toBe(true);
  });

  it('keeps the lock and the snapshot under different keys', async () => {
    const { store, data } = make();
    await store.lock('a');
    await store.write(snapshot);
    expect(data.size).toBe(2);
  });
});
