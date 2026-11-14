import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/redis.mock';

const query = vi.hoisted(() => vi.fn());
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { query },
  clickhouseLongQueries: { query },
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: (_key: string, fn: () => Promise<unknown>) => fn(),
}));

const EVENT = {
  name: 'e',
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  teams: [],
  scoring: {
    capPerActorPerOwnerPerDay: 10,
    types: { view: { weight: 1, once: 'day' as const, entities: ['Image' as const] } },
    newAccountDays: 7,
    finalizeAfterMs: 0,
  },
};
const NOW = new Date('2026-11-10T12:00:00.000Z');
const PLACED = {
  cosmeticId: 1,
  claimKey: 'k1',
  entityType: 'Image',
  entityId: 10,
  startedAt: new Date('2026-11-09T00:00:00.000Z'),
};

// $queryRaw in call order: the open placements, the hidden people, the first new account.
function postgres(hidden: number[]) {
  dbMock.dbRead.$queryRaw
    .mockResolvedValueOnce([PLACED] as never)
    .mockResolvedValueOnce(hidden.map((id) => ({ id })) as never)
    .mockResolvedValueOnce([] as never);
}
const ledger = (rows: object[]) => query.mockResolvedValue({ json: async () => rows });
const row = (actorId: number, points: number) => ({
  cosmeticId: 1,
  claimKey: 'k1',
  actorId,
  hatPoints: points,
  points,
  views: 1,
});

async function load() {
  vi.resetModules();
  return (await import('~/server/events/points/placement-stats')).getHatPlacementStats;
}

beforeEach(() => {
  query.mockReset();
  dbMock.dbRead.$queryRaw.mockReset();
});

describe('getHatPlacementStats', () => {
  it('leaves out what hidden people gave, as the referee does', async () => {
    const get = await load();
    postgres([5]);
    ledger([row(5, 4), row(6, 3)]);
    expect(await get(EVENT, 100, NOW)).toEqual([
      { cosmeticId: 1, claimKey: 'k1', points: 3, views: 1 },
    ]);
  });

  it('shows nothing for an owner the referee hides', async () => {
    const get = await load();
    postgres([100]);
    ledger([row(6, 3)]);
    expect(await get(EVENT, 100, NOW)).toEqual([
      { cosmeticId: 1, claimKey: 'k1', points: 0, views: 0 },
    ]);
  });

  it('returns null when ClickHouse fails, then leaves it alone for a while', async () => {
    const get = await load();
    postgres([]);
    query.mockRejectedValue(new Error('Timeout exceeded'));
    expect(await get(EVENT, 100, NOW)).toBeNull();
    dbMock.dbRead.$queryRaw.mockResolvedValue([PLACED] as never);
    expect(await get(EVENT, 100, NOW)).toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });
});
