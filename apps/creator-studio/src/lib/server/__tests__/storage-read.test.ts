import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  queries: [] as string[],
}));

vi.mock('@civitai/db/kysely', () => ({
  sql: (strings: TemplateStringsArray) => {
    state.queries.push(strings.join('?').replace(/\s+/g, ' '));
    return { execute: async () => ({ rows: state.rows }) };
  },
}));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));
vi.mock('$lib/server/logger', () => ({
  getLogger: () => ({ logToAxiom: async () => undefined }),
}));

const { loadStorageUsage, toStorageUsage } = await import('../storage');

const usageRow = (over: Record<string, unknown> = {}) => ({
  requestedAt: null,
  computedAt: null,
  kind: 'model',
  publicStatus: 'public',
  baseModel: 'SDXL 1.0',
  month: '2026-01-01',
  fileCount: 1,
  bytes: 100,
  ...over,
});

const requests = () => state.queries.filter((q) => q.includes('INSERT INTO "UserStorageRollup"'));

describe('toStorageUsage', () => {
  it('takes the rollup state from the joined row and drops the empty usage side', () => {
    const u = toStorageUsage([
      usageRow({ requestedAt: '2026-09-25T10:00:00.000Z', computedAt: null, kind: null }),
    ] as never);
    expect(u).toEqual({
      ready: true,
      state: { requestedAt: '2026-09-25T10:00:00.000Z', computedAt: null },
      rows: [],
    });
  });

  it('reads no rollup row as no state, and keeps every usage row', () => {
    const u = toStorageUsage([usageRow(), usageRow({ kind: 'image', baseModel: '' })] as never);
    expect(u.state).toBeNull();
    expect(u.rows.map((r) => r.kind)).toEqual(['model', 'image']);
  });
});

describe('loadStorageUsage', () => {
  beforeEach(() => {
    state.queries = [];
  });

  it('queues a first count and reports it as first', async () => {
    state.rows = [usageRow()];
    const u = await loadStorageUsage(1);
    expect(u.media).toBe('first');
    expect(requests()).toHaveLength(1);
  });

  it('queues a stale refresh and reports the old totals as refreshing', async () => {
    state.rows = [
      usageRow({ requestedAt: '2026-01-01T00:00:00.000Z', computedAt: '2026-01-01T00:01:00.000Z' }),
    ];
    const u = await loadStorageUsage(1);
    expect(u.media).toBe('refreshing');
    expect(requests()).toHaveLength(1);
  });

  it('asks for nothing when a count is already queued', async () => {
    state.rows = [usageRow({ requestedAt: new Date().toISOString(), computedAt: null })];
    const u = await loadStorageUsage(1);
    expect(u.media).toBe('first');
    expect(requests()).toHaveLength(0);
  });

  it('leaves an already-queued refresh alone in SQL too, so a second tab cannot requeue it', async () => {
    state.rows = [usageRow()];
    await loadStorageUsage(1);
    const [sqlText] = requests();
    expect(sqlText).toContain(
      'OR ("UserStorageRollup"."imagesComputedAt" < timezone(\'UTC\', now()) - interval \'24 hours\' AND "UserStorageRollup"."imagesRequestedAt" <= "UserStorageRollup"."imagesComputedAt")'
    );
  });
});
