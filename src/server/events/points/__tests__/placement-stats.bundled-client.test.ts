import { TupleParam } from '@clickhouse/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/redis.mock';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import {
  bundledClientCopy,
  fakeClickhouse,
} from '~/server/events/points/__tests__/clickhouse-wire';

// In production the shared ClickHouse client can come from a different bundled copy of
// @clickhouse/client than the code building the query. The params must reach ClickHouse the same
// way from either copy; when they did not, every hats-page read failed with "expected '('" and the
// views line showed nothing.
const ch = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return ch.client;
  },
  get clickhouseLongQueries() {
    return ch.client;
  },
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: (_key: string, fn: () => Promise<unknown>) => fn(),
}));

const NOW = new Date('2026-11-10T12:00:00.000Z');
const PLACED = [
  {
    cosmeticId: 1,
    claimKey: "it's-k1",
    entityType: 'Image',
    entityId: 11,
    startedAt: new Date('2026-11-09T06:00:00.000Z'),
  },
  {
    cosmeticId: 2,
    claimKey: 'k2',
    entityType: 'Image',
    entityId: 12,
    startedAt: new Date('2026-11-05T00:00:00.000Z'),
  },
];

let fake: Awaited<ReturnType<typeof fakeClickhouse>> | undefined;
beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockReset();
  dbMock.dbRead.$queryRaw.mockResolvedValue(PLACED as never);
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function sentBy(mod?: Parameters<typeof fakeClickhouse>[0]) {
  fake = await fakeClickhouse(mod);
  ch.client = fake.client;
  vi.resetModules();
  const { getHatPlacementViews } = await import('~/server/events/points/placement-stats');
  expect(await getHatPlacementViews('e', 100, NOW)).not.toBeNull();
  expect(fake.sent).toHaveLength(1);
  const sent = fake.sent[0];
  await fake.close();
  fake = undefined;
  return sent;
}

describe('hat placement views through a bundled ClickHouse client', () => {
  it('sends the same params from a second copy of the client as from the app copy', async () => {
    const copy = bundledClientCopy();
    // A real second copy, or this would pass on the broken code too.
    expect(new copy.TupleParam([]) instanceof TupleParam).toBe(false);
    const fromApp = await sentBy();
    const fromCopy = await sentBy(copy);
    expect(fromCopy).toEqual(fromApp);
  });
});
