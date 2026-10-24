import { beforeEach, describe, expect, it, vi } from 'vitest';

// The storage tables arrive by a hand-applied migration, so the page must render its empty state, not a
// 500, when they do not exist yet. Postgres reports that as SQLSTATE 42P01.
const state = vi.hoisted(() => ({ error: null as null | { code?: string }, logged: 0 }));

vi.mock('@civitai/db/kysely', () => ({
  sql: () => ({
    execute: async () => {
      if (state.error) throw state.error;
      return { rows: [] };
    },
  }),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));

vi.mock('$lib/server/logger', () => ({
  getLogger: () => ({
    logToAxiom: async () => {
      state.logged++;
    },
  }),
}));

const { getStorageUsage, requestMediaRollup } = await import('../storage');

describe('storage reads before the migration is applied', () => {
  beforeEach(() => {
    state.error = null;
    state.logged = 0;
  });

  it('reports not-ready, not an empty creator, when the tables do not exist', async () => {
    state.error = Object.assign(new Error('relation "UserStorageRollup" does not exist'), {
      code: '42P01',
    });
    await expect(getStorageUsage(1)).resolves.toEqual({ ready: false, state: null, rows: [] });
    state.error = null;
    await expect(getStorageUsage(1)).resolves.toEqual({ ready: true, state: null, rows: [] });
  });

  it('does not swallow any other database error', async () => {
    state.error = Object.assign(new Error('canceling statement due to conflict with recovery'), {
      code: '40001',
    });
    await expect(getStorageUsage(1)).rejects.toThrow('conflict with recovery');
  });

  it('skips the rollup request quietly when the table is missing, and logs anything else', async () => {
    state.error = { code: '42P01' };
    await expect(requestMediaRollup(1)).resolves.toBeUndefined();
    expect(state.logged).toBe(0);

    state.error = { code: '57014' };
    await expect(requestMediaRollup(1)).resolves.toBeUndefined();
    expect(state.logged).toBe(1);
  });
});
