import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (q: string) => {
      sql.push(q);
      return [];
    },
  }),
}));

vi.mock('$lib/server/db', () => {
  // `then` must resolve to undefined, or every chain object is thenable and `await` hangs on it.
  const chain = (rows: unknown[]): unknown =>
    new Proxy({ execute: async () => rows } as Record<string, unknown>, {
      get: (t, prop: string) => (prop === 'then' ? undefined : (t[prop] ?? (() => chain(rows)))),
    });
  const rowsFor: Record<string, unknown[]> = {
    'ModelVersion as mv': [
      {
        versionId: 101,
        versionName: 'v1',
        modelId: 7,
        modelName: 'M',
        modelType: 'LORA',
        nsfw: false,
      },
    ],
    // A goal on the version, so the donations read runs too and all six reads are checked.
    DonationGoal: [{ id: 5, entityType: 'ModelVersion', entityId: 101, modelVersionId: null }],
  };
  return { dbRead: { selectFrom: (table: string) => chain(rowsFor[table] ?? []) } };
});

const { getModelPerformance } = await import('../models-earnings');

const window = {
  userId: 42,
  from: '2023-02-14',
  to: '2026-11-15',
  compareFrom: '2023-02-14',
  compareTo: '2023-02-13',
};

beforeEach(() => {
  sql.length = 0;
});

describe('getModelPerformance query time limit', () => {
  it('bounds every ClickHouse read when a limit is passed (the all-time view)', async () => {
    await getModelPerformance({ ...window, maxExecutionSeconds: 10 });
    expect(sql).toHaveLength(6);
    const unbounded = sql.filter((q) => !/SETTINGS max_execution_time = 10\s*$/.test(q));
    expect(unbounded).toEqual([]);
  });

  it('leaves the month reads unbounded', async () => {
    await getModelPerformance(window);
    expect(sql).toHaveLength(6);
    expect(sql.filter((q) => q.includes('max_execution_time'))).toEqual([]);
  });
});
