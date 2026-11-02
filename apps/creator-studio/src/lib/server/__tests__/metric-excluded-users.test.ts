import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as { userId: unknown }[],
  down: false,
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
});

describe('getMetricExcludedUserIds (Creator Studio)', () => {
  it('returns the ids, dropping null and non-numeric rows rather than treating them as user 0', async () => {
    state.rows = [{ userId: 7 }, { userId: '12' }, { userId: null }, { userId: 'x' }];
    expect(await getMetricExcludedUserIds()).toEqual([7, 12]);
  });

  it('fails open to [] when the source cannot be read, so everyone is listed and counted', async () => {
    state.down = true;
    expect(await getMetricExcludedUserIds()).toEqual([]);
  });
});
