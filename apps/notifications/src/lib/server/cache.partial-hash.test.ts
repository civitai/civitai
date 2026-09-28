import { beforeEach, describe, expect, it, vi } from 'vitest';

// The unread-count cache against a stateful redis fake, so a hash's provenance (a complete write by
// setUser, or one assembled by HINCRBY) is observable across calls.
const h = vi.hoisted(() => {
  type Entry = { hash: Map<string, string>; ttl: number };
  const store = new Map<string, Entry>();
  const dbTruth: { rows: { category: string; count: number }[] } = { rows: [] };
  const dbQueries = { count: 0, lastSql: '' };
  // Runs after the recount has taken its snapshot and before it returns: a write that lands mid-query.
  const hooks: { duringQuery?: () => Promise<void> } = {};

  const entry = (key: string, create = false) => {
    let e = store.get(key);
    if (!e && create) store.set(key, (e = { hash: new Map(), ttl: -1 }));
    return e;
  };

  const fakeRedis = {
    hGetAll: async (key: string) => Object.fromEntries(entry(key)?.hash ?? []),
    exists: async (key: string) => (store.has(key) ? 1 : 0),
    hExists: async (key: string, field: string) => (entry(key)?.hash.has(field) ? 1 : 0),
    expire: async (key: string, seconds: number) => {
      const e = entry(key);
      if (!e) return false;
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
    cancellableQuery: async (sql: string) => {
      dbQueries.count++;
      dbQueries.lastSql = sql;
      const snapshot = dbTruth.rows.map((r) => ({ ...r }));
      return {
        result: async () => {
          const during = hooks.duringQuery;
          hooks.duringQuery = undefined;
          await during?.();
          return snapshot;
        },
      };
    },
  };

  return { store, dbTruth, dbQueries, hooks, fakeRedis, readPool };
});

vi.mock('./clients/redis', () => ({ getRedis: () => h.fakeRedis }));
vi.mock('./lag', () => ({
  getNotifDbWithoutLag: async () => h.readPool,
  isWritePool: () => false,
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('./clients/db', () => ({ notifDbWrite: () => h.readPool, notifDbRead: () => h.readPool }));

import { notificationCache } from './cache';
import { COUNT_ROW_LIMIT, countInFlight, countNotifications } from './operations';

const USER = 7;
const KEY = `system:notification-counts:${USER}`;
const WEEK = 60 * 60 * 24 * 7;

const seed = (fields: Record<string, string>, ttl: number) =>
  h.store.set(KEY, { hash: new Map(Object.entries(fields)), ttl });
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
  h.hooks.duringQuery = undefined;
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

    expect(snapshot()?.fields).toEqual({ __complete: '0', Update: '301', Comment: '40' });
  });

  // Prod held both shapes: no TTL from a bare HINCRBY, and a TTL added later by a mark-read's EXPIRE.
  it.each([
    ['no TTL', -1],
    ['a TTL', 3600],
  ])(
    'recounts a counter with %s that lacks the completeness marker, dropping its stale fields',
    async (_label, ttl) => {
      seed({ Update: '8', Like: '5' }, ttl);

      expect(await badge()).toBe(340);
      expect(snapshot()).toEqual({
        fields: { __complete: '0', Update: '300', Comment: '40' },
        ttl: WEEK,
      });
    }
  );

  // Control for the case above: the fake does serve a hit, so a recount there is the marker rule acting.
  it('serves a counter that carries the completeness marker without touching the DB', async () => {
    seed({ __complete: '0', Update: '8' }, 3600);

    expect(await countNotifications({ userId: USER, unread: true })).toEqual([
      { category: 'Update', count: 8 },
    ]);
    expect(h.dbQueries.count).toBe(0);
  });

  it('a mark-read on a partial counter does not make it trusted', async () => {
    seed({ Update: '8' }, -1);

    await notificationCache.decrementUser(USER, 'Update');

    expect(await badge()).toBe(340);
  });

  it('shows a notification committed during a recount that found nothing unread', async () => {
    h.dbTruth.rows = [];
    h.hooks.duringQuery = async () => {
      h.dbTruth.rows = [{ category: 'Update', count: 1 }];
      await notificationCache.incrementUser(USER, 'Update');
    };

    expect(await badge()).toBe(0);
    expect(await badge()).toBe(1);
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

describe('unread counter cache: bounded recount', () => {
  const truncated = () => [
    { category: 'Update', count: COUNT_ROW_LIMIT - 16 },
    { category: 'Milestone', count: 17 },
  ];

  it('stops the recount one row past the limit', async () => {
    await badge();

    expect(h.dbQueries.lastSql).toMatch(
      new RegExp(String.raw`LIMIT ${COUNT_ROW_LIMIT + 1}\s*\) scanned`)
    );
  });

  it('reports every count as a floor when the recount hits the limit, and caches that', async () => {
    h.dbTruth.rows = truncated();

    const first = await countNotifications({ userId: USER, unread: true });
    const cached = await countNotifications({ userId: USER, unread: true });

    expect(first.map((c) => c.floor)).toEqual([true, true]);
    expect(cached.map((c) => c.floor)).toEqual([true, true]);
    expect(h.dbQueries.count).toBe(1);
  });

  it('reports exact counts at exactly the limit', async () => {
    h.dbTruth.rows = [{ category: 'Update', count: COUNT_ROW_LIMIT }];

    expect(await countNotifications({ userId: USER, unread: true })).toEqual([
      { category: 'Update', count: COUNT_ROW_LIMIT },
    ]);
  });

  it('recounts instead of decrementing a floor, so it never turns into an exact number', async () => {
    h.dbTruth.rows = truncated();
    await badge();

    await notificationCache.decrementUser(USER, 'Milestone');

    expect(snapshot()).toBeUndefined();
  });

  it('still decrements an exact counter', async () => {
    await badge();

    await notificationCache.decrementUser(USER, 'Update');

    expect(snapshot()?.fields).toEqual({ __complete: '0', Update: '299', Comment: '40' });
  });
});
