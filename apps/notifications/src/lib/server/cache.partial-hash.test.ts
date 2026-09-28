import { beforeEach, describe, expect, it, vi } from 'vitest';

// The unread-count cache against a stateful redis fake that keeps real TTL semantics, so a hash's
// provenance (written by setUser with a TTL, or conjured by HINCRBY with none) is observable. The DB is
// a fake read pool whose GROUP BY answer is the ground truth the badge must match.
const h = vi.hoisted(() => {
  type Entry = { hash: Map<string, string>; ttl: number };
  const store = new Map<string, Entry>();
  const dbTruth: { rows: { category: string; count: number }[] } = { rows: [] };
  const dbQueries = { count: 0 };

  const entry = (key: string, create = false) => {
    let e = store.get(key);
    if (!e && create) store.set(key, (e = { hash: new Map(), ttl: -1 }));
    return e;
  };

  const fakeRedis = {
    hGetAll: async (key: string) => Object.fromEntries(entry(key)?.hash ?? []),
    ttl: async (key: string) => (store.has(key) ? store.get(key)!.ttl : -2),
    exists: async (key: string) => (store.has(key) ? 1 : 0),
    expire: async (key: string, seconds: number, mode?: 'XX') => {
      const e = entry(key);
      if (!e || (mode === 'XX' && e.ttl === -1)) return false;
      e.ttl = seconds;
      return true;
    },
    hIncrBy: async (key: string, field: string, by: number) => {
      const e = entry(key, true)!;
      const next = Number(e.hash.get(field) ?? 0) + by;
      e.hash.set(field, String(next));
      return next;
    },
    hGet: async (key: string, field: string) => entry(key)?.hash.get(field) ?? null,
    hSet: async (key: string, field: string, value: string) => {
      entry(key, true)!.hash.set(field, value);
      return 1;
    },
    hDel: async (key: string, field: string) => {
      const e = entry(key);
      if (!e?.hash.delete(field)) return 0;
      if (e.hash.size === 0) store.delete(key);
      return 1;
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    hSetMultiWithExpire: async (key: string, fields: string[], ttlSeconds: number) => {
      if (fields.length === 0) return 0;
      const e = entry(key, true)!;
      for (let i = 0; i < fields.length; i += 2) e.hash.set(fields[i], fields[i + 1]);
      e.ttl = ttlSeconds;
      return fields.length / 2;
    },
  };

  const readPool = {
    cancellableQuery: async () => {
      dbQueries.count++;
      return { result: async () => dbTruth.rows.map((r) => ({ ...r })) };
    },
  };

  return { store, dbTruth, dbQueries, fakeRedis, readPool };
});

vi.mock('./clients/redis', () => ({ getRedis: () => h.fakeRedis }));
vi.mock('./lag', () => ({
  getNotifDbWithoutLag: async () => h.readPool,
  isWritePool: () => false,
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('./clients/db', () => ({ notifDbWrite: () => h.readPool, notifDbRead: () => h.readPool }));

import { notificationCache } from './cache';
import { countInFlight, countNotifications } from './operations';

const USER = 7;
const KEY = `system:notification-counts:${USER}`;

const snapshot = () => {
  const e = h.store.get(KEY);
  return e ? { fields: Object.fromEntries(e.hash), ttl: e.ttl } : undefined;
};
const badge = async () =>
  (await countNotifications({ userId: USER, unread: true })).reduce(
    (sum, { count }) => sum + Number(count),
    0
  );

beforeEach(() => {
  h.store.clear();
  h.dbQueries.count = 0;
  countInFlight.clear();
  h.dbTruth.rows = [
    { category: 'Update', count: 300 },
    { category: 'Comment', count: 40 },
  ];
});

describe('unread counter cache: partial hashes', () => {
  it('a fan-out increment onto an absent counter leaves it absent', async () => {
    await notificationCache.incrementUser(USER, 'Update');

    expect(snapshot()).toBeUndefined();
  });

  it('a fan-out increment onto a cached counter still counts', async () => {
    expect(await badge()).toBe(340);

    await notificationCache.incrementUser(USER, 'Update');

    expect(snapshot()?.fields).toEqual({ Update: '301', Comment: '40' });
  });

  it('recounts from the DB a counter that has no TTL, and caches the result with one', async () => {
    h.store.set(KEY, { hash: new Map([['Update', '8']]), ttl: -1 });

    expect(await badge()).toBe(340);
    expect(snapshot()).toEqual({ fields: { Update: '300', Comment: '40' }, ttl: 60 * 60 * 24 * 7 });
  });

  it('a mark-read on a counter with no TTL does not make it trusted', async () => {
    h.store.set(KEY, { hash: new Map([['Update', '8']]), ttl: -1 });

    await notificationCache.decrementUser(USER, 'Update');

    expect(await badge()).toBe(340);
  });

  // Control for the case above: the fake does serve a hit, so a recount there is the TTL rule acting.
  it('serves a counter that has a TTL without touching the DB', async () => {
    h.store.set(KEY, { hash: new Map([['Update', '8']]), ttl: 3600 });

    expect(await badge()).toBe(8);
    expect(h.dbQueries.count).toBe(0);
  });

  it('shows the full count after the counter expires and a notification arrives before the next read', async () => {
    expect(await badge()).toBe(340);

    h.store.delete(KEY);
    h.dbTruth.rows = [
      { category: 'Update', count: 301 },
      { category: 'Comment', count: 40 },
    ];
    await notificationCache.incrementUser(USER, 'Update');

    expect(await badge()).toBe(341);
  });
});
