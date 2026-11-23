import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserPreferences from '~/server/services/user-preferences.service';

const { queryMock, visibleMock } = vi.hoisted(() => ({ queryMock: vi.fn(), visibleMock: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: queryMock } }));
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
import { CacheTTL } from '~/server/common/constants';
import { getRisingSongIds } from '../song-rising.service';

const VIEWER = { id: 4, isModerator: false };
const MUSIC_ON = { features: { music: true }, user: VIEWER };
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

const sqlOf = () => (queryMock.mock.calls[0][0] as TemplateStringsArray).join('?');

describe('getRisingSongIds', () => {
  let stored: { data: unknown; cachedAt: number } | null;

  beforeEach(() => {
    vi.clearAllMocks();
    stored = null;
    redisMock.redis.packed.get.mockImplementation(async () => stored);
    redisMock.redis.packed.set.mockImplementation(async (_key: string, value: typeof stored) => {
      stored = value;
    });
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
    visibleMock.mockImplementation(async ({ ids }: { ids: number[] }) => new Set(ids));
    dbMock.dbRead.$queryRaw.mockImplementation(answerVisibilityRead);
  });

  it('ranks songs by plays over today and the 6 days before, ties newest first', async () => {
    queryMock.mockResolvedValue([
      { entityId: 30, plays: '9' },
      { entityId: 12, plays: '4' },
      { entityId: 11, plays: '4' },
    ]);

    expect(await getRisingSongIds(MUSIC_ON)).toEqual([30, 12, 11]);

    // Secondary guard on the query the ranking relies on.
    const sql = sqlOf().replace(/\s+/g, ' ');
    expect(sql).toContain('FROM entityMetricDailyAgg_v2_prev');
    expect(sql).toContain("entityType = 'Image' AND metricType = 'Play'");
    expect(sql).toContain('day >= today() - 6');
    expect(sql).toContain('sum(total)');
    expect(sql).toContain('HAVING plays > 0');
    expect(sql).toContain('ORDER BY plays DESC, entityId DESC');
    expect(sql).toContain('LIMIT 100');
  });

  it('drops the songs the viewer may not open, keeping the order of the rest', async () => {
    queryMock.mockResolvedValue([30, 20, 12, 11].map((entityId) => ({ entityId, plays: '1' })));
    visibleMock.mockResolvedValue(new Set([11, 30]));

    expect(await getRisingSongIds(MUSIC_ON)).toEqual([30, 11]);
    expect(visibleMock).toHaveBeenCalledWith({
      ids: [30, 20, 12, 11],
      userId: 4,
      isModerator: false,
    });
  });

  it('keeps one list for every viewer: a miss writes it back and the next viewer reads it', async () => {
    queryMock.mockResolvedValue([{ entityId: 5, plays: '3' }]);

    expect(await getRisingSongIds(MUSIC_ON)).toEqual([5]);
    expect(await getRisingSongIds({ features: { music: true } })).toEqual([5]);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.packed.set).toHaveBeenCalledWith(
      'packed:caches:rising-songs',
      expect.objectContaining({ data: [5] }),
      expect.anything(),
      expect.anything()
    );
    expect(visibleMock).toHaveBeenLastCalledWith({
      ids: [5],
      userId: undefined,
      isModerator: undefined,
    });
  });

  it('serves the list for CacheTTL.md, then reads ClickHouse again', async () => {
    queryMock.mockResolvedValue([{ entityId: 9, plays: '1' }]);

    stored = { data: [5, 4], cachedAt: Date.now() - (CacheTTL.md - 30) * 1000 };
    expect(await getRisingSongIds(MUSIC_ON)).toEqual([5, 4]);
    expect(queryMock).not.toHaveBeenCalled();

    stored = { data: [5, 4], cachedAt: Date.now() - (CacheTTL.md + 30) * 1000 };
    expect(await getRisingSongIds(MUSIC_ON)).toEqual([9]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('reads nothing with the music flag off', async () => {
    expect(await getRisingSongIds({ features: { music: false }, user: VIEWER })).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
    expect(visibleMock).not.toHaveBeenCalled();
  });
});
