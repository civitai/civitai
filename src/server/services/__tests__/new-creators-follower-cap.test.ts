import { beforeEach, describe, expect, it } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

import { getNewCreatorUserIds } from '~/server/services/new-creators.service';

// `$queryRaw` is a tagged template whose filters arrive as interpolated `Prisma.Sql` values.
// Interleave strings and values so a clause reads in order, operand included.
function emittedSql() {
  const render = (strings: readonly string[], values: readonly unknown[]): string =>
    strings.reduce((out, str, i) => out + str + (i < values.length ? value(values[i]) : ''), '');
  const value = (v: unknown): string => {
    const sql = v as { strings?: readonly string[]; values?: readonly unknown[] } | null;
    return sql?.strings ? render(sql.strings, sql.values ?? []) : String(v);
  };
  return (dbMock.dbRead.$queryRaw.mock.calls as unknown[][])
    .map(([strings, ...values]) => render(strings as readonly string[], values))
    .join('\n');
}

const cacheKeysRead = () =>
  (redisMock.redis.packed.get.mock.calls as unknown[][]).map((args) => String(args[0]));

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockReset();
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
  dbMock.dbRead.keyValue.findUnique.mockReset();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  redisMock.redis.packed.get.mockClear();
  // A cache miss with the stampede lock taken, so the query runs.
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
});

// Whitespace-insensitive, so the assertions pin the clause and where it sits, not the indentation.
const sql = () => emittedSql().replace(/\s+/g, ' ');

describe('getNewCreatorUserIds follower cap', () => {
  // 500, not the production 1000, so a hard-coded threshold cannot pass.
  it('filters on all-time follower count in the WHERE clause', async () => {
    const ids = await getNewCreatorUserIds({ entity: 'images', maxFollowers: 500 });

    expect(ids).toEqual([1, 2]);
    // The whole ON clause: another timeframe makes the cap a near no-op (weekly gains), and no
    // timeframe at all fans each creator out once per timeframe under the 200-row LIMIT.
    expect(sql()).toContain(
      `LEFT JOIN "UserMetric" um ON um."userId" = lr."userId" AND um.timeframe = 'AllTime' WHERE`
    );
    // In the WHERE, right before ORDER BY: inside the LEFT JOIN's ON it would filter nothing.
    expect(sql()).toMatch(/\) AND COALESCE\(um\."followerCount", 0\) < 500 ORDER BY lr\.position/);
  });

  it('treats a cap of 0 as a cap, not as no cap', async () => {
    await getNewCreatorUserIds({ entity: 'images', maxFollowers: 0 });

    expect(sql()).toMatch(/COALESCE\(um\."followerCount", 0\) < 0 ORDER BY/);
    expect(cacheKeysRead()).toEqual([expect.stringMatching(/:images-new:max-followers-0$/)]);
  });

  // The uncapped list backs the /images?newCreators=true browse feed, which Justin did not ask
  // to cap. If this starts failing, the browse feed just lost every creator over the threshold.
  it('leaves the uncapped browse-feed list unfiltered', async () => {
    await getNewCreatorUserIds({ entity: 'images' });

    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(1);
    expect(sql()).not.toMatch(/UserMetric|followerCount/);
  });

  // Sharing a key would let whichever caller filled the cache first decide for the other for
  // a whole hour: the browse feed would intermittently lose its 1k+ creators, or the home
  // block would intermittently get them back.
  it('caches the capped list under its own key', async () => {
    await getNewCreatorUserIds({ entity: 'images' });
    await getNewCreatorUserIds({ entity: 'images', maxFollowers: 500 });

    const [uncapped, capped] = cacheKeysRead();
    expect(uncapped).toMatch(/:images-new$/);
    expect(capped).toMatch(/:images-new:max-followers-500$/);
  });
});
