import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('~/server/services/metric-excluded-users.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMetricExcludedUserIdsOrThrow: vi.fn(),
  getMetricExcludedUserIds: vi.fn(),
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn({ on: vi.fn() }),
  }),
  getJobDate: vi.fn(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import { getJobDate } from '~/server/jobs/job';
import {
  getMetricExcludedUserIds,
  getMetricExcludedUserIdsOrThrow,
} from '~/server/services/metric-excluded-users.service';
import {
  clickhouseLeaderboardPopulation,
  leaderboardJobs,
  populateLeaderboard,
} from '../prepare-leaderboard';

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
    expect(userIdsInserted().sort((a, b) => a - b)).toEqual([1, 2]);
  });

  // Ranked in SQL here: the predicate must sit in the ranked query's WHERE for positions to re-number.
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

describe('prepare-leaderboard job', () => {
  const prepareLeaderboard = leaderboardJobs[0];
  const setLastRun = vi.fn();
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.mocked(getJobDate).mockResolvedValue([new Date(0), setLastRun] as never);
    vi.mocked(pgDbReadLong.query).mockResolvedValue({ rows: [] } as never);
    vi.mocked(pgDbReadLong.cancellableQuery).mockResolvedValue({ result: async () => [] } as never);
    vi.mocked(pgDbWrite.query).mockResolvedValue({
      rows: [{ count: 0, date: '2026-10-14' }],
    } as never);
    dbMock.dbWrite.leaderboard.findMany.mockResolvedValue([
      { id: 'generators', query: 'WITH clickhouse_x AS (SELECT 1) SELECT 1' },
    ] as never);
    mockClickhouse.$query.mockResolvedValue([
      { userId: 1, score: 30, metrics: '{}' },
      { userId: EXCLUDED, score: 20, metrics: '{}' },
    ]);
  });

  it('reads the exclusion list, retrying a failed read, and applies it to the boards and legends', async () => {
    vi.mocked(getMetricExcludedUserIdsOrThrow)
      .mockRejectedValueOnce(new Error('clickhouse blip'))
      .mockResolvedValue([EXCLUDED]);

    vi.useFakeTimers();
    const run = prepareLeaderboard.run();
    await vi.runAllTimersAsync();
    await run;
    vi.useRealTimers();

    expect(userIdsInserted()).toEqual([1]);
    const legendsSql = vi
      .mocked(pgDbReadLong.cancellableQuery)
      .mock.calls.map(([sql]) => sql as string)
      .find((sql) => sql.includes('"LeaderboardResult" lr'));
    expect(legendsSql).toMatch(/\bu\.id <> ALL\('\{7\}'::int\[\]\)/);
    expect(setLastRun).toHaveBeenCalled();
  });

  it('retries the read, then populates unfiltered and logs when the list stays unreadable', async () => {
    vi.useFakeTimers();
    vi.mocked(getMetricExcludedUserIdsOrThrow).mockRejectedValue(new Error('clickhouse down'));
    vi.mocked(getMetricExcludedUserIds).mockResolvedValue([EXCLUDED]);

    const run = prepareLeaderboard.run();
    await vi.runAllTimersAsync();
    await run;
    vi.useRealTimers();

    expect(getMetricExcludedUserIdsOrThrow).toHaveBeenCalledTimes(4);
    expect(userIdsInserted()).toEqual([1, EXCLUDED]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'leaderboard-metric-exclusion-unavailable' })
    );
    expect(setLastRun).toHaveBeenCalled();
  });
});
