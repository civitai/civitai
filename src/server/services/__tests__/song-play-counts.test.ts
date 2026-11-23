import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserPreferences from '~/server/services/user-preferences.service';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = fetchMock;
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/env/server', () => ({
  env: new Proxy(
    { CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS: 50, LOGGING: [] as string[] } as Record<string, unknown>,
    {
      get: (target, prop) => {
        if (prop in target) return target[prop as string];
        if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
          return 'https://test:test@localhost:5432/test';
        if (
          typeof prop === 'string' &&
          /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
        )
          return 1;
        return undefined;
      },
    }
  ),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
const { visibleMock } = vi.hoisted(() => ({ visibleMock: vi.fn() }));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const actual = await importOriginal<typeof UserPreferences>();
  return {
    ...actual,
    BlockedByUsers: { ...actual.BlockedByUsers, getCached: vi.fn(async () => []) },
  };
});

import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';
import { getSongPlayCounts } from '../image.service';

/**
 * Answers the visibility read (`getImageIdsVisibleToViewer`'s SQL) through `visibleMock`, called with the
 * ids and viewer read back from the query: the ids from `i.id IN (…)`, the viewer from
 * `i."userId" = …`, a moderator by the absence of visibility conditions. Other raw reads get no rows.
 */
async function answerVisibilityRead(strings: TemplateStringsArray, ...values: Prisma.Sql[]) {
  const query = Prisma.sql(strings, ...values);
  if (!query.text.includes('LEFT JOIN "Post" p ON p.id = i."postId"')) return [];
  const param = (placeholder: string) => query.values[Number(placeholder.slice(1)) - 1];
  const idList = query.text.match(/i\.id IN \(([^)]*)\)/)?.[1] ?? '';
  const ids = (idList.match(/\$\d+/g) ?? []).map((p) => param(p) as number);
  const isModerator = !query.text.includes('"needsReview" IS NULL');
  const userParam = query.text.match(/i\."userId" = (\$\d+)/)?.[1];
  const userId = userParam ? (param(userParam) as number | undefined) : undefined;
  const visible: Set<number> = await visibleMock({
    ids,
    userId,
    isModerator: isModerator || (userId === undefined ? undefined : false),
  });
  return [...visible].map((id) => ({ id, userId: 0 }));
}

const VIEWER = { id: 4, isModerator: false };
const MUSIC_ON = { features: { music: true }, user: VIEWER };

describe('getSongPlayCounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    visibleMock.mockImplementation(async ({ ids }: { ids: number[] }) => new Set(ids));
    dbMock.dbRead.$queryRaw.mockImplementation(answerVisibilityRead);
  });

  it("reads a song's Play from the metric reader, and 0 when it has none", async () => {
    fetchMock.mockResolvedValue({ 1: { Play: 7, Like: 2 }, 2: { Play: 0, Like: 3 } });

    const plays = await getSongPlayCounts({ ids: [1, 2, 3], ...MUSIC_ON });

    expect(fetchMock).toHaveBeenCalledWith('Image', [1, 2, 3]);
    expect(plays).toEqual({ 1: 7, 2: 0, 3: 0 });
  });

  it('gives no count for a song the viewer cannot open', async () => {
    visibleMock.mockResolvedValue(new Set([1]));
    fetchMock.mockResolvedValue({ 1: { Play: 7 } });

    const plays = await getSongPlayCounts({ ids: [1, 2], ...MUSIC_ON });

    expect(visibleMock).toHaveBeenCalledWith({ ids: [1, 2], userId: 4, isModerator: false });
    expect(fetchMock).toHaveBeenCalledWith('Image', [1]);
    expect(plays).toEqual({ 1: 7 });
  });

  it('gives no count for a song whose metrics were cached before plays were read', async () => {
    fetchMock.mockResolvedValue({ 1: { Like: 3 }, 2: { Play: 5 } });

    expect(await getSongPlayCounts({ ids: [1, 2], ...MUSIC_ON })).toEqual({ 2: 5 });

    fetchMock.mockRejectedValue(new Error('socket hang up'));
    redisMock.redis.hGetAll.mockImplementation(async (key: string) =>
      key.endsWith(':1') ? { Like: '1' } : { Play: '0', Like: '1' }
    );
    expect(await getSongPlayCounts({ ids: [1, 2], ...MUSIC_ON })).toEqual({ 2: 0 });
  });

  it('reads Play from the cached hash when ClickHouse cannot answer', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    redisMock.redis.hGetAll.mockImplementation(async (key: string) =>
      key.endsWith(':1') ? { Play: '12', Like: '1' } : {}
    );

    const plays = await getSongPlayCounts({ ids: [1, 2], ...MUSIC_ON });

    // An id the cache cannot answer is unknown: left out, so the card shows no count.
    expect(plays).toEqual({ 1: 12 });
  });

  it('reads nothing with the music flag off', async () => {
    const plays = await getSongPlayCounts({ ids: [1], features: { music: false }, user: VIEWER });

    expect(plays).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
