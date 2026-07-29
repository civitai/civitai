import { beforeEach, describe, expect, it, vi } from 'vitest';

// Coverage for the bulk producer path (operations.ts createNotificationsBulk). Re-derives the fix from
// #2437 (daceheg): the UPDATE and the INSERT ... ON CONFLICT fallback both MERGE the incoming recipients
// into the existing PendingNotification.users array (dedup union) instead of wholesale-replacing it, so a
// concurrent/earlier writer's recipients for the same key aren't dropped before the worker fans them out.
//
// Same "fake pool records SQL + params" idiom as operations.test.ts — the fake never runs SQL, so these
// assert the emitted statement shape, matching the existing suites' contract.

const h = vi.hoisted(() => {
  const state = {
    notifCalls: [] as Array<{ sql: string; params?: unknown[] }>,
    // Keys the UPDATE ... RETURNING reports as already-present; the rest fall through to INSERT.
    updatedKeys: [] as string[],
  };
  const reset = () => {
    state.notifCalls = [];
    state.updatedKeys = [];
  };
  return { state, reset };
});

vi.mock('./clients/db', () => ({
  notifDbWrite: () => ({
    cancellableQuery: async (sql: string, params?: unknown[]) => {
      h.state.notifCalls.push({ sql, params });
      if (sql.includes('UPDATE "PendingNotification"')) {
        return { result: async () => h.state.updatedKeys.map((key) => ({ key })) };
      }
      return { result: async () => [] as unknown[] };
    },
  }),
  notifDbRead: () => ({ cancellableQuery: async () => ({ result: async () => [] }) }),
}));
vi.mock('./cache', () => ({ notificationCache: {} }));
vi.mock('./lag', () => ({
  getNotifDbWithoutLag: async () => ({}),
  isWritePool: () => false,
  preventReplicationLag: async () => {},
}));
vi.mock('./clients/axiom', () => ({ logToAxiom: vi.fn(async () => {}), safeError: (e: unknown) => e }));

import { createNotificationsBulk } from './operations';

const updateCall = () => h.state.notifCalls.find((c) => c.sql.includes('UPDATE "PendingNotification"'));
const insertCall = () => h.state.notifCalls.find((c) => c.sql.includes('INSERT INTO "PendingNotification"'));

const row = (key: string, users: number[]) => ({
  key,
  type: 'comment',
  category: 'Comment' as const,
  users,
  details: { foo: 'bar' },
});

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
});

describe('createNotificationsBulk users-array merge on upsert', () => {
  it('UPDATE unions the existing row with the incoming set and dedups — never a bare replace', async () => {
    h.state.updatedKeys = ['comment:1']; // existing key → UPDATE handles it, no INSERT
    await createNotificationsBulk([row('comment:1', [11, 22])]);

    const upd = updateCall()!;
    expect(upd.sql).toContain('unnest(pn."users" || u.users::int[])');
    expect(upd.sql).toContain('SELECT DISTINCT');
    expect(upd.sql).not.toMatch(/SET\s+"users"\s*=\s*u\.users::int\[\]/);
    // Every key was already present, so nothing falls through to INSERT.
    expect(insertCall()).toBeUndefined();
  });

  it('INSERT ... ON CONFLICT unions the existing row with excluded and dedups — never a bare replace', async () => {
    h.state.updatedKeys = []; // no key existed → all fall through to INSERT
    await createNotificationsBulk([row('comment:1', [11, 22])]);

    const ins = insertCall()!;
    expect(ins.sql).toContain('unnest("PendingNotification"."users" || excluded."users")');
    expect(ins.sql).toContain('SELECT DISTINCT');
    expect(ins.sql).not.toMatch(/"users"\s*=\s*excluded\."users"/);
  });
});
