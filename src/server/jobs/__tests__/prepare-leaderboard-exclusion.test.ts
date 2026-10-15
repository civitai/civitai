import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClickhouse } = vi.hoisted(() => ({ mockClickhouse: { $query: vi.fn() } }));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mockClickhouse }));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbReadLong: { cancellableQuery: vi.fn(), query: vi.fn() },
  pgDbWrite: { query: vi.fn(), cancellableQuery: vi.fn() },
}));
vi.mock('~/server/jobs/apply-discord-roles', () => ({ applyDiscordLeaderboardRoles: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));
vi.mock('~/server/services/leaderboard.service', () => ({
  getUnpopulatedLeaderboards: vi.fn(),
  isLeaderboardPopulated: vi.fn(),
}));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: vi.fn(),
}));

import { pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import { clickhouseLeaderboardPopulation, populateLeaderboard } from '../prepare-leaderboard';

const EXCLUDED = 7;
const base = {
  jobContext: { on: vi.fn() } as never,
  includesCTE: true,
  addDays: 0,
  excludedUserIds: [EXCLUDED],
};

function writtenSql() {
  return vi.mocked(pgDbWrite.cancellableQuery).mock.calls.map(([sql]) => sql as string);
}

// Each insert inlines its rows as a JSON literal; read back the users it would write.
function userIdsInserted() {
  return writtenSql().flatMap((sql) => {
    const json = sql.match(/'(\[.*\])'::jsonb/s)?.[1];
    if (!json) throw new Error('no inlined rows in insert');
    return (JSON.parse(json) as { userId: number }[]).map((row) => row.userId);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pgDbWrite.cancellableQuery).mockResolvedValue({
    result: async () => [],
    cancel: vi.fn(),
  } as never);
  vi.mocked(pgDbWrite.query).mockResolvedValue({ rows: [{ date: '2026-10-14' }] } as never);
});

describe('leaderboard population drops metric-excluded accounts', () => {
  it('ClickHouse boards: the excluded account is not inserted, the control is', async () => {
    mockClickhouse.$query.mockResolvedValue([
      { userId: 1, score: 30, metrics: '{}' },
      { userId: EXCLUDED, score: 20, metrics: '{}' },
      { userId: 2, score: 10, metrics: '{}' },
    ]);

    await clickhouseLeaderboardPopulation({
      ...base,
      id: 'generators',
      query: 'WITH clickhouse_x AS (SELECT 1) SELECT 1',
    });

    expect(userIdsInserted()).toEqual([1, 2]);
  });

  // Filtered before the 1000 cut, so an excluded account does not cost the board a slot.
  it('ClickHouse boards: the board still fills to 1000 when an excluded account ranks inside it', async () => {
    mockClickhouse.$query.mockResolvedValue(
      Array.from({ length: 1001 }, (_, i) => ({ userId: i + 1, score: 2000 - i, metrics: '{}' }))
    );

    await clickhouseLeaderboardPopulation({
      ...base,
      id: 'generators',
      query: 'WITH clickhouse_x AS (SELECT 1) SELECT 1',
    });

    const inserted = userIdsInserted();
    expect(inserted).toHaveLength(1000);
    expect(inserted).not.toContain(EXCLUDED);
    expect(inserted).toContain(1001);
  });

  it('image-score boards: the excluded account is not inserted, the control is', async () => {
    vi.mocked(pgDbReadLong.query).mockResolvedValue({
      rows: [
        { userId: 1, score: 30, metrics: {} },
        { userId: EXCLUDED, score: 20, metrics: {} },
        { userId: 2, score: 10, metrics: {} },
      ],
    } as never);

    const populated = await populateLeaderboard(
      { ...base, id: 'images', query: 'WITH image_scores AS (SELECT 1)' },
      async () => [1, 2]
    );

    expect(populated).toBe(true);
    expect(userIdsInserted().sort()).toEqual([1, 2]);
  });

  // The ranking happens in SQL here, so the predicate has to sit in the ranked query's WHERE, before
  // row_number and LIMIT, for positions to re-number around the excluded account.
  it('Postgres boards: the ranked query excludes the account before numbering', async () => {
    vi.mocked(pgDbReadLong.cancellableQuery).mockResolvedValue({ result: async () => [] } as never);

    await populateLeaderboard(
      { ...base, id: 'pg-board', query: 'WITH scores AS (SELECT 1) SELECT 1' },
      async () => [1, 2]
    );

    const sql = vi.mocked(pgDbReadLong.cancellableQuery).mock.calls[0][0] as string;
    const where = sql.slice(sql.indexOf('WHERE'), sql.lastIndexOf('ORDER BY score DESC'));
    expect(where).toMatch(/\bu\.id <> ALL\('\{7\}'::int\[\]\)/);
  });

  it('refuses a non-integer id rather than inline it into SQL', async () => {
    vi.mocked(pgDbReadLong.cancellableQuery).mockResolvedValue({ result: async () => [] } as never);

    await expect(
      populateLeaderboard(
        {
          ...base,
          excludedUserIds: ['1); DROP TABLE x; --' as never],
          id: 'pg-board',
          query: 'WITH scores AS (SELECT 1) SELECT 1',
        },
        async () => [1, 2]
      )
    ).rejects.toThrow('excluded user ids must be integers');
    expect(pgDbReadLong.cancellableQuery).not.toHaveBeenCalled();
  });
});
