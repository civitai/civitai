import { describe, expect, it, vi } from 'vitest';

// Inject a fake pool that records the SQL + params instead of hitting a DB, so we can assert the dynamic
// WHERE-clause construction and `$n` param indexing (the real off-by-one risk) with zero infra.
const { captured, fakePool } = vi.hoisted(() => {
  const captured: Array<{ sql: string; params?: unknown[] }> = [];
  const fakePool = {
    cancellableQuery: async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { result: async () => [] as unknown[] };
    },
  };
  return { captured, fakePool };
});

vi.mock('./lag', () => ({
  getNotifDbWithoutLag: async () => fakePool,
  isWritePool: () => false,
  preventReplicationLag: async () => {},
}));
vi.mock('./clients/db', () => ({ notifDbWrite: () => fakePool, notifDbRead: () => fakePool }));
// count() consults the cache first; force a miss so it always runs the DB query under test.
vi.mock('./cache', () => ({
  notificationCache: { getUser: async () => undefined, setUser: async () => {}, bustUser: async () => {} },
}));

import { countNotifications, queryNotifications } from './operations';

describe('queryNotifications SQL', () => {
  it('indexes $-params correctly with unread + category + cursor', async () => {
    captured.length = 0;
    const cursor = new Date('2026-07-01T00:00:00.000Z');
    await queryNotifications({ userId: 42, limit: 10, cursor, category: 'Comment', unread: true });

    const { sql, params } = captured[0];
    expect(params).toEqual([42, 'Comment', cursor, 10]);
    expect(sql).toContain('un."userId" = $1');
    expect(sql).toContain('un.viewed IS FALSE');
    expect(sql).toContain('n.category = $2::"NotificationCategory"');
    expect(sql).toContain('un."createdAt" < $3');
    expect(sql).toContain('LIMIT $4');
  });

  it('omits optional clauses and keeps LIMIT at the right index', async () => {
    captured.length = 0;
    await queryNotifications({ userId: 7, limit: 5 });

    const { sql, params } = captured[0];
    expect(params).toEqual([7, 5]);
    expect(sql).not.toContain('viewed IS FALSE');
    expect(sql).not.toContain('n.category =');
    expect(sql).toContain('LIMIT $2');
  });
});

describe('countNotifications SQL', () => {
  it('indexes the category param after userId', async () => {
    captured.length = 0;
    await countNotifications({ userId: 99, unread: true, category: 'System' });

    const { sql, params } = captured[0];
    expect(params).toEqual([99, 'System']);
    expect(sql).toContain('un."userId" = $1');
    expect(sql).toContain('un.viewed IS FALSE');
    expect(sql).toContain('n.category = $2::"NotificationCategory"');
    expect(sql).toContain('GROUP BY category');
  });
});
