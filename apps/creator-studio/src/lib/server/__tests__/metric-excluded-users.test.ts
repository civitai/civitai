import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as { userId: unknown }[],
  down: false,
  hang: false,
}));

// Narrow fakes: `cache` and `clickhouse` build clients at import. No Redis here: every read goes to the fetcher, as the real cache does when Redis is down.
vi.mock('$lib/server/cache', () => ({
  createCache: (def: { fetch: (args: object) => Promise<unknown> }) => ({
    get: (args: object) => def.fetch(args),
  }),
}));
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async () => {
      if (state.down) throw new Error('clickhouse down');
      if (state.hang) return new Promise(() => undefined);
      return state.rows;
    },
  }),
}));
vi.mock('$lib/server/logger', () => ({
  getLogger: () => ({
    logToAxiom: async () => undefined,
  }),
}));

const { getMetricExcludedUserIds } = await import('../metric-excluded-users');

beforeEach(() => {
  state.rows = [];
  state.down = false;
  state.hang = false;
});

describe('getMetricExcludedUserIds (Creator Studio)', () => {
  it('returns only valid int4 user ids, so a bad row cannot break the query that uses the list', async () => {
    state.rows = [
      { userId: 7 },
      { userId: '12' },
      { userId: null },
      { userId: 'x' },
      { userId: 1.5 },
      { userId: 3_000_000_000 },
    ];
    expect(await getMetricExcludedUserIds()).toEqual([7, 12]);
  });

  it('fails open to [] when the source cannot be read, so everyone is listed and counted', async () => {
    state.down = true;
    expect(await getMetricExcludedUserIds()).toEqual([]);
  });

  it('fails open to [] when the source stalls, instead of holding the page', async () => {
    vi.useFakeTimers();
    try {
      state.hang = true;
      let settled: number[] | undefined;
      void getMetricExcludedUserIds().then((ids) => (settled = ids));
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
