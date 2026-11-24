import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as ClickhouseClient from '~/server/clickhouse/client';

/**
 * `userDownloadsCache` backs the "downloaded" badges and the download history. Most of its
 * lookups are for users with no downloads at all, so it caches that empty answer too. The empty
 * answer must not outlive a first download: the download paths call `bustUserDownloadsCache`, and
 * the next lookup has to see the new row.
 */

// The downloads table, as ClickHouse would answer the cache's lookup: userId → rows.
type Row = { userId: number; modelVersionId: number; fileId: number; lastDownloaded: string };
const table = new Map<number, Row[]>();
// Users named in each lookup the cache sent to ClickHouse.
const lookups: number[][] = [];

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {
    // The lookup interpolates `userIds.join(',')` into its WHERE ... IN (...).
    $query: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const userIds = String(values[0]).split(',').map(Number);
      lookups.push(userIds);
      return userIds.flatMap((id) => table.get(id) ?? []);
    },
  },
}));

const { userDownloadsCache } = await import('~/server/redis/caches');
const { bustUserDownloadsCache } = await import('~/server/services/user.service');

const NO_DOWNLOADS = 4_401;
const T0 = new Date('2026-11-20T12:00:00Z').getTime();
const lookupsFor = (userId: number) => lookups.filter((ids) => ids.includes(userId)).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  installFakeCacheRedis();
  table.clear();
  lookups.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('userDownloadsCache: users with no downloads', () => {
  it('answers a second lookup from the cache instead of ClickHouse', async () => {
    expect(await userDownloadsCache.fetch([NO_DOWNLOADS])).toEqual({});
    expect(await userDownloadsCache.fetch([NO_DOWNLOADS])).toEqual({});

    expect(lookupsFor(NO_DOWNLOADS)).toBe(1);
  });

  it('sees a first download on the next lookup after the download path busts', async () => {
    expect(await userDownloadsCache.fetch([NO_DOWNLOADS])).toEqual({});

    // What the download route does: the event lands in the table, then the route busts.
    table.set(NO_DOWNLOADS, [
      {
        userId: NO_DOWNLOADS,
        modelVersionId: 9_102,
        fileId: 7_731,
        lastDownloaded: '2026-11-20 12:00:05',
      },
    ]);
    vi.setSystemTime(T0 + 5_000);
    await bustUserDownloadsCache(NO_DOWNLOADS);

    expect(await userDownloadsCache.fetch([NO_DOWNLOADS])).toEqual({
      [NO_DOWNLOADS]: {
        userId: NO_DOWNLOADS,
        downloads: [
          {
            modelVersionId: 9_102,
            fileId: 7_731,
            lastDownloaded: new Date('2026-11-20T12:00:05Z').getTime(),
          },
        ],
      },
    });
  });

  it('re-checks ClickHouse once the empty answer is 10 minutes old', async () => {
    await userDownloadsCache.fetch([NO_DOWNLOADS]);

    vi.setSystemTime(T0 + 9 * 60_000);
    await userDownloadsCache.fetch([NO_DOWNLOADS]);
    expect(lookupsFor(NO_DOWNLOADS)).toBe(1);

    vi.setSystemTime(T0 + 10 * 60_000 + 1_000);
    await userDownloadsCache.fetch([NO_DOWNLOADS]);
    expect(lookupsFor(NO_DOWNLOADS)).toBe(2);
  });
});
