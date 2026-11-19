import { describe, expect, it } from 'vitest';
import { createKvSnapshotStore } from '../snapshot';

const snapshotData = { namespace: { key: 'default' }, flags: [{ key: 'f', enabled: true }] };

describe('createKvSnapshotStore', () => {
  function fakeKv() {
    const data = new Map<string, string>();
    const writes: string[] = [];
    return {
      data,
      writes,
      kv: {
        get: async (key: string) => data.get(key) ?? null,
        set: async (key: string, value: string) => {
          writes.push(key);
          data.set(key, value);
        },
      },
    };
  }
  const opts = { key: 'snap', maxAgeMs: 86_400_000, refreshIntervalMs: 600_000, log: () => {} };

  it('round-trips a snapshot', async () => {
    const { kv } = fakeKv();
    const store = createKvSnapshotStore({ kv, ...opts });
    await store.save({ savedAt: 1_000, etag: '"a"', data: snapshotData }, true);
    expect(await store.load()).toEqual({ savedAt: 1_000, etag: '"a"', data: snapshotData });
  });

  it('writes an unchanged state at most once per refresh interval', async () => {
    const { kv, writes } = fakeKv();
    const store = createKvSnapshotStore({ kv, ...opts });
    await store.save({ savedAt: 1_000, etag: '"a"', data: snapshotData }, true);
    await store.save({ savedAt: 1_000 + 599_999, etag: '"a"', data: snapshotData }, false);
    expect(writes.filter((k) => k === 'snap')).toHaveLength(1);
    await store.save({ savedAt: 1_000 + 600_000, etag: '"a"', data: snapshotData }, false);
    expect(writes.filter((k) => k === 'snap')).toHaveLength(2);
  });

  it('writes a changed state at once', async () => {
    const { kv, writes } = fakeKv();
    const store = createKvSnapshotStore({ kv, ...opts });
    await store.save({ savedAt: 1_000, etag: '"a"', data: snapshotData }, true);
    await store.save({ savedAt: 1_001, etag: '"b"', data: { flags: [] } }, true);
    expect(writes.filter((k) => k === 'snap')).toHaveLength(2);
    expect((await store.load())?.etag).toBe('"b"');
  });

  it('a process that is merely unchanged does not overwrite a different stored state', async () => {
    const { kv } = fakeKv();
    const store = createKvSnapshotStore({ kv, ...opts });
    await store.save({ savedAt: 1_000, etag: '"new"', data: snapshotData }, true);
    await store.save({ savedAt: 1_000 + 600_000, etag: '"old"', data: { flags: [] } }, false);
    expect((await store.load())?.etag).toBe('"new"');
    // ...unless nobody has kept the stored copy current for two intervals.
    await store.save({ savedAt: 1_000 + 1_200_000, etag: '"old"', data: { flags: [] } }, false);
    expect((await store.load())?.etag).toBe('"old"');
  });

  it('loads nothing from an unreadable value', async () => {
    const { kv, data } = fakeKv();
    data.set('snap', 'not json');
    expect(await createKvSnapshotStore({ kv, ...opts }).load()).toBeNull();
  });

  it('skips a snapshot over the size cap', async () => {
    const { kv, writes } = fakeKv();
    const store = createKvSnapshotStore({ kv, ...opts, maxBytes: 10 });
    await store.save({ savedAt: 1_000, etag: '"a"', data: snapshotData }, true);
    expect(writes).toHaveLength(0);
  });
});
