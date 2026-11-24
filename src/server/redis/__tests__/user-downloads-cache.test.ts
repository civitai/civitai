import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as FliptClient from '~/server/flipt/client';
import promClient from 'prom-client';

/**
 * `userDownloadsCache` backs the "downloaded" badges and the download history. Many of its
 * lookups are for users with no downloads at all, so it caches that empty answer too. The empty
 * answer must not outlive a first download: the download paths call `bustUserDownloadsCache`, and
 * the next lookup has to see the new row.
 */

// The downloads table, as ClickHouse would answer the cache's lookup: userId → rows.
type Row = { userId: number; modelVersionId: number; fileId: number; lastDownloaded: string };
const { table, lookups, dedicatedLookups, dedicated, isFliptSyncMock } = vi.hoisted(() => ({
  table: new Map<number, Row[]>(),
  // Users named in each lookup the cache sent to the shared ClickHouse / the dedicated replica.
  lookups: [] as number[][],
  dedicatedLookups: [] as { userIds: number[]; query: string }[],
  dedicated: {
    configured: false,
    failWith: null as Error | null,
    flags: {} as Record<string, boolean | null>,
  },
  isFliptSyncMock: vi.fn(),
}));

// The lookup interpolates `userIds.join(',')` into its WHERE ... IN (...).
const userIdsIn = (query: string) =>
  (/userId IN \(([^)]*)\)/.exec(query)?.[1] ?? '').split(',').map(Number);
const answer = (userIds: number[]) => userIds.flatMap((id) => table.get(id) ?? []);

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {
    $query: async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const query =
        typeof strings === 'string'
          ? strings
          : strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ''), '');
      const userIds = userIdsIn(query);
      lookups.push(userIds);
      return answer(userIds);
    },
  },
}));

vi.mock('~/server/clickhouse/downloads-client', () => ({
  get clickhouseDownloads() {
    return dedicated.configured ? {} : undefined;
  },
  queryDownloadsClickhouse: async (query: string) => {
    const userIds = userIdsIn(query);
    dedicatedLookups.push({ userIds, query });
    if (dedicated.failWith) throw dedicated.failWith;
    return answer(userIds);
  },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: isFliptSyncMock,
  getFliptClientSync: () => ({}),
}));

const { userDownloadsCache } = await import('~/server/redis/caches');
const { bustUserDownloadsCache } = await import('~/server/services/user.service');
const { resetDownloadsClickhouseGatesForTests } = await import(
  '~/server/services/downloads-clickhouse'
);

const NO_DOWNLOADS = 4_401;
const T0 = new Date('2026-11-20T12:00:00Z').getTime();
const lookupsFor = (userId: number) => lookups.filter((ids) => ids.includes(userId)).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  installFakeCacheRedis();
  table.clear();
  lookups.length = 0;
  dedicatedLookups.length = 0;
  dedicated.configured = false;
  dedicated.failWith = null;
  dedicated.flags = {};
  isFliptSyncMock.mockImplementation((key: string) => dedicated.flags[key] ?? null);
  // After faking Date, so the gate's clock is the fake one.
  resetDownloadsClickhouseGatesForTests();
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

describe('userDownloadsCache: a bust outlasts a late row', () => {
  // On the dedicated replica the row can land about two minutes after the download, so the bust
  // window (180 s) must outlast that. Here the row lands 150 s after the bust, and a lookup 145 s
  // after it runs before the row is there: far past the cache's default 10 s window, which
  // re-cached the pre-download answer at that lookup.
  const lateRow = {
    userId: NO_DOWNLOADS,
    modelVersionId: 9_103,
    fileId: 7_732,
    lastDownloaded: '2026-11-20 12:01:00',
  };

  it('no earlier downloads: a row landing 150 s after the bust is seen on a lookup at 170 s', async () => {
    expect(await userDownloadsCache.fetch([NO_DOWNLOADS])).toEqual({});

    await bustUserDownloadsCache(NO_DOWNLOADS);
    vi.setSystemTime(T0 + 145_000);
    expect(await userDownloadsCache.fetch([NO_DOWNLOADS])).toEqual({});

    table.set(NO_DOWNLOADS, [lateRow]);
    vi.setSystemTime(T0 + 170_000);
    expect((await userDownloadsCache.fetch([NO_DOWNLOADS]))[NO_DOWNLOADS]?.downloads).toEqual([
      { modelVersionId: 9_103, fileId: 7_732, lastDownloaded: Date.parse('2026-11-20T12:01:00Z') },
    ]);
  });

  it('earlier downloads: a row landing 150 s after the bust is seen once the window is over', async () => {
    const earlier = { ...lateRow, modelVersionId: 9_100, lastDownloaded: '2026-11-19 08:00:00' };
    table.set(NO_DOWNLOADS, [earlier]);
    expect((await userDownloadsCache.fetch([NO_DOWNLOADS]))[NO_DOWNLOADS]?.downloads).toHaveLength(
      1
    );

    await bustUserDownloadsCache(NO_DOWNLOADS);
    vi.setSystemTime(T0 + 145_000);
    await userDownloadsCache.fetch([NO_DOWNLOADS]);

    table.set(NO_DOWNLOADS, [lateRow, earlier]);
    vi.setSystemTime(T0 + 181_000);
    expect(
      (await userDownloadsCache.fetch([NO_DOWNLOADS]))[NO_DOWNLOADS]?.downloads.map(
        (d) => d.modelVersionId
      )
    ).toEqual([9_103, 9_100]);
  });
});

// The "flag off" and "without the dedicated client" cases are INVARIANT guards: they hold on the
// code before the dedicated replica existed too, and pin that adding it changed nothing while it is
// not selected.
describe('userDownloadsCache: which ClickHouse answers', () => {
  const FLAG = 'user-downloads-dedicated-clickhouse';
  const USER = 4_402;
  // Only on the table both sides read, so an answer names no client by itself: the lookups do.
  const ROW = {
    userId: USER,
    modelVersionId: 9_104,
    fileId: 7_733,
    lastDownloaded: '2026-11-20 11:00:00',
  };

  const fallbacks = async () => {
    const metric = promClient.register.getSingleMetric(
      'civitai_app_downloads_clickhouse_fallback_total'
    );
    if (!metric) throw new Error('fallback counter is not registered');
    const { values } = await metric.get();
    return (
      values.find((v) => v.labels.site === 'user-downloads' && v.labels.reason === 'error')
        ?.value ?? 0
    );
  };

  beforeEach(() => {
    dedicated.configured = true;
    table.set(USER, [ROW]);
  });

  it('flag off: the shared client only', async () => {
    dedicated.flags[FLAG] = false;

    expect((await userDownloadsCache.fetch([USER]))[USER]?.downloads).toHaveLength(1);
    expect(lookupsFor(USER)).toBe(1);
    expect(dedicatedLookups).toHaveLength(0);
  });

  it('flag on: the dedicated replica only, with the same statement the shared client is sent', async () => {
    dedicated.flags[FLAG] = true;

    expect((await userDownloadsCache.fetch([USER]))[USER]?.downloads).toEqual([
      { modelVersionId: 9_104, fileId: 7_733, lastDownloaded: Date.parse('2026-11-20T11:00:00Z') },
    ]);
    expect(lookupsFor(USER)).toBe(0);
    expect(dedicatedLookups.map((l) => l.userIds)).toEqual([[USER]]);
    expect(dedicatedLookups[0].query.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT userId, modelVersionId, fileId, max(lastDownloaded) as lastDownloaded FROM userModelDownloads WHERE userId IN (4402) GROUP BY userId, modelVersionId, fileId ORDER BY lastDownloaded DESC LIMIT 2000 BY userId'
    );
  });

  it('flag on without the dedicated client: the shared client', async () => {
    dedicated.configured = false;
    dedicated.flags[FLAG] = true;

    await userDownloadsCache.fetch([USER]);
    expect(lookupsFor(USER)).toBe(1);
    expect(dedicatedLookups).toHaveLength(0);
  });

  it('a failed replica read is re-run once on the shared client and counted', async () => {
    dedicated.flags[FLAG] = true;
    dedicated.failWith = new Error('connect ECONNREFUSED');
    const before = await fallbacks();

    expect((await userDownloadsCache.fetch([USER]))[USER]?.downloads).toHaveLength(1);
    expect(dedicatedLookups).toHaveLength(1);
    expect(lookupsFor(USER)).toBe(1);
    expect((await fallbacks()) - before).toBe(1);
  });
});
