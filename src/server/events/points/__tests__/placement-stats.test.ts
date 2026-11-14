import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/redis.mock';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

const query = vi.hoisted(() => vi.fn());
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { query },
  clickhouseLongQueries: { query },
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: (_key: string, fn: () => Promise<unknown>) => fn(),
}));

const NOW = new Date('2026-11-10T12:00:00.000Z');
const placed = (cosmeticId: number, startedAt: string) => ({
  cosmeticId,
  claimKey: `k${cosmeticId}`,
  entityType: 'Image',
  entityId: 10 + cosmeticId,
  startedAt: new Date(startedAt),
});
const PLACED = [placed(1, '2026-11-09T06:00:00.000Z'), placed(2, '2026-11-05T00:00:00.000Z')];
const ledger = (rows: object[]) => query.mockResolvedValue({ json: async () => rows });

async function load() {
  vi.resetModules();
  return (await import('~/server/events/points/placement-stats')).getHatPlacementViews;
}

beforeEach(() => {
  query.mockReset();
  dbMock.dbRead.$queryRaw.mockReset();
  dbMock.dbRead.$queryRaw.mockResolvedValue(PLACED as never);
});

describe('getHatPlacementViews', () => {
  it('reads each hat from its own placement on, and reports a hat with no views as 0', async () => {
    const get = await load();
    ledger([{ cosmeticId: 1, claimKey: 'k1', views: '7' }]);
    expect(await get('e', 100, NOW)).toEqual([
      { cosmeticId: 1, claimKey: 'k1', views: 7 },
      { cosmeticId: 2, claimKey: 'k2', views: 0 },
    ]);
    const params = query.mock.calls[0][0].query_params;
    expect(params.from).toBe('2026-11-05 00:00:00.000');
    expect(params.placements).toEqual([
      [1, 'k1', 'Image', 11, '2026-11-09 06:00:00.000'],
      [2, 'k2', 'Image', 12, '2026-11-05 00:00:00.000'],
    ]);
  });

  it('asks ClickHouse once for a user reloading while a read is in flight', async () => {
    const get = await load();
    ledger([]);
    await Promise.all([get('e', 100, NOW), get('e', 100, NOW), get('e', 100, NOW)]);
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns null when ClickHouse fails, then leaves it alone for a while', async () => {
    const get = await load();
    query.mockRejectedValue(new Error('Timeout exceeded'));
    expect(await get('e', 100, NOW)).toBeNull();
    expect(await get('e', 101, NOW)).toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });
});
