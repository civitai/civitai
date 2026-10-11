import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  cacheNames: [] as string[],
  // One version's resourceCompensations rows, by source. Amounts are distinct powers of two so any wrong
  // grouping produces a total no correct grouping can.
  earnRows: [] as { source: string; cur: number; prev: number }[],
}));

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ name, fetch }: { name: string; fetch: (args: A) => Promise<R> }) => {
    state.cacheNames.push(name);
    return { get: fetch };
  },
}));

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      if (!/FROM orchestration\.resourceCompensations/.test(sql)) return [];
      if (!/GROUP BY modelVersionId, accountType, source/.test(sql))
        throw new Error(`fake ClickHouse expects the per-source earnings read: ${sql.slice(0, 120)}`);
      return state.earnRows.map((r) => ({
        modelVersionId: '101',
        accountType: 'Yellow',
        source: r.source,
        cur: String(r.cur),
        prev: String(r.prev),
      }));
    },
  }),
}));

vi.mock('$lib/server/db', () => {
  // `then` must resolve to undefined, or every chain object is thenable and `await` hangs on it.
  const chain = (terminals: Record<string, unknown>): unknown =>
    new Proxy(terminals, {
      get: (t, prop: string) => {
        if (prop === 'then') return undefined;
        return t[prop] ?? (() => chain(t));
      },
    });
  // Both reads of the catalog hit ModelVersion under different projections, so serve one row carrying both.
  const version = {
    id: 101,
    versionId: 101,
    name: 'v1',
    versionName: 'v1',
    baseModel: 'SDXL',
    modelId: 7,
    modelName: 'Model',
    modelType: 'LORA',
    nsfw: false,
  };
  return {
    dbRead: {
      selectFrom: (table: string) => {
        if (table.startsWith('ModelVersion')) return chain({ execute: async () => [version] });
        if (table === 'Model')
          return chain({
            executeTakeFirst: async () => ({
              id: 7,
              name: 'Model',
              userId: 42,
              nsfw: false,
              nsfwLevel: 1,
            }),
          });
        return chain({ execute: async () => [] });
      },
    },
  };
});

const { getModelPerformance, getModelVersionAnalytics, payoutChannel } = await import(
  '../models-earnings'
);

const range = { from: '2026-10-01', to: '2026-10-08', compareFrom: '2026-09-23', compareTo: '2026-09-30' };

type Split = {
  channels: Record<'compensation' | 'tip' | 'licenseFee', { total: number; prev: number }>;
  buzzTotal: number;
  prevBuzzTotal: number;
};
// Tips move out of compensation; the creator's total does not change.
const split = (r: Split) => ({
  compensation: [r.channels.compensation.total, r.channels.compensation.prev],
  tip: [r.channels.tip.total, r.channels.tip.prev],
  licenseFee: [r.channels.licenseFee.total, r.channels.licenseFee.prev],
  buzz: [r.buzzTotal, r.prevBuzzTotal],
});
const EXPECTED = { compensation: [90, 9], tip: [20, 2], licenseFee: [40, 4], buzz: [150, 15] };

describe('tips are their own channel, as on the main dashboard (#5582)', () => {
  beforeEach(() => {
    state.earnRows = [
      { source: 'compensation', cur: 10, prev: 1 },
      { source: 'tip', cur: 20, prev: 2 },
      { source: 'licenseFee', cur: 40, prev: 4 },
      { source: 'compensation_recovered_20260507', cur: 80, prev: 8 },
    ];
  });

  it('maps tip and licenseFee to their own channels and every other source to compensation', () => {
    expect(payoutChannel('tip')).toBe('tip');
    expect(payoutChannel('licenseFee')).toBe('licenseFee');
    expect(payoutChannel('compensation')).toBe('compensation');
    expect(payoutChannel('compensation_recovered_20260507')).toBe('compensation');
    expect(payoutChannel('some-future-source')).toBe('compensation');
  });

  it('splits the per-model analytics table', async () => {
    const [row] = await getModelPerformance({ userId: 42, ...range });
    expect(split(row)).toEqual(EXPECTED);
    expect(row.channels.tip.received).toEqual([{ currency: 'yellow', total: 20, prev: 2 }]);
  });

  it('splits the per-version table on a model page', async () => {
    const result = await getModelVersionAnalytics({ userId: 42, modelId: 7, ...range });
    if (!result) throw new Error('fake Postgres should resolve the model as the caller’s');
    const [v] = result.versions;
    expect(split(v)).toEqual(EXPECTED);
  });

  // A tripwire, not a proof: it pins this bump only. A value cached under v4 has no `tip` channel and the pages
  // read `channels.tip.received` unguarded, so the next change to the channel set needs its own bump too.
  it('caches both channel-carrying reads under keys no pre-tips value was stored under', () => {
    expect(state.cacheNames).toContain('models:performance:v5');
    expect(state.cacheNames).toContain('analytics:model-versions:v5');
    expect(state.cacheNames).not.toContain('models:performance:v4');
    expect(state.cacheNames).not.toContain('analytics:model-versions:v4');
  });
});
