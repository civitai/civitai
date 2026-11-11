import { describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const query = vi.hoisted(() =>
  vi.fn(async (_arg: { query: string; query_params?: Record<string, unknown> }) => ({
    json: async () => [],
  }))
);
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { query } }));

const {
  queryReferee,
  REFEREE_CLICKHOUSE_BUDGET_S,
  REFEREE_FULL_CLICKHOUSE_BUDGET_S,
  refereeWindow,
  runEventPointsReferee,
} = await import('~/server/events/points/referee');
const { LIVE_BUCKET_MS } = await import('~/server/events/points/keys');
const { eventPointsRefereeSql, eventPointsRefereeUsersSql } = await import(
  '~/server/events/points/referee.sql'
);

const EVENT = {
  name: 'e',
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  teams: [],
  scoring: { capPerActorPerOwnerPerDay: 50, types: {}, newAccountDays: 7, finalizeAfterMs: 0 },
};

// The client's request_timeout (300 s, pinned in client-config-pins.test.ts) is a socket idle timer:
// a query allowed past it must keep the socket busy, or the client drops it while the server runs on.
describe('referee ClickHouse queries', () => {
  type Settings = {
    max_execution_time?: number;
    send_progress_in_http_headers?: number;
    http_headers_progress_interval_ms?: string;
  };
  const settingsFor = (sql: string) =>
    (
      query.mock.calls.find(([arg]) => (arg as { query: string }).query === sql)?.[0] as
        | { clickhouse_settings?: Settings }
        | undefined
    )?.clickhouse_settings;

  it('share one budget: the settle query gets what the users query left', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T12:07:00.000Z') });
    try {
      redisMock.sysRedis.hGetAll.mockResolvedValue({});
      query.mockClear();
      query.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 200_000);
        return { json: async () => [] };
      });
      await queryReferee(EVENT, refereeWindow(EVENT, 'live', new Date()));
      expect(query).toHaveBeenCalledTimes(2);
      expect(settingsFor(eventPointsRefereeUsersSql)?.max_execution_time).toBe(
        REFEREE_CLICKHOUSE_BUDGET_S
      );
      expect(settingsFor(eventPointsRefereeSql)?.max_execution_time).toBe(
        REFEREE_CLICKHOUSE_BUDGET_S - 200
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the socket busy more often than the client request timeout', async () => {
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    query.mockClear();
    await queryReferee(EVENT, refereeWindow(EVENT, 'live', new Date('2026-11-05T12:07:00.000Z')));
    for (const sql of [eventPointsRefereeUsersSql, eventPointsRefereeSql]) {
      const settings = settingsFor(sql);
      expect(settings?.send_progress_in_http_headers).toBe(1);
      expect(Number(settings?.http_headers_progress_interval_ms)).toBeLessThan(300_000);
    }
    // With the idle timer kept quiet, only this stops the client waiting on an overrunning query.
    for (const [arg] of query.mock.calls)
      expect((arg as { abort_signal?: unknown }).abort_signal).toBeInstanceOf(AbortSignal);
  });

  // floor() of a sub-second remainder is 0, which ClickHouse reads as no cap at all.
  it('starts no query with under a second of budget left', async () => {
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    query.mockClear();
    await expect(
      queryReferee(
        EVENT,
        refereeWindow(EVENT, 'live', new Date('2026-11-05T12:07:00.000Z')),
        Date.now() + 500
      )
    ).rejects.toThrow('budget');
    expect(query).not.toHaveBeenCalled();
  });
});

// The alert has to fire on the runs that then fail, or a stuck settle goes unseen.
describe('runEventPointsReferee', () => {
  it('logs a stale cut before a settle query that fails', async () => {
    const now = new Date('2026-11-05T12:07:00.000Z');
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    redisMock.sysRedis.get.mockResolvedValue(
      String((now.getTime() - 5 * 60 * 60 * 1000) / LIVE_BUCKET_MS)
    );
    query.mockClear();
    query.mockRejectedValueOnce(new Error('Timeout exceeded'));
    loggingMock.logToAxiom.mockClear();
    await expect(runEventPointsReferee(EVENT, 'live', now)).rejects.toThrow('Timeout exceeded');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'event-points-cut-stale', event: 'e' })
    );
  });
});

// The WHERE of every scan of the ledger table, one per branch.
function ledgerScans(sql: string) {
  return [...sql.matchAll(/FROM event_point_events\s*\n((?:[ \t]*(?:WHERE|AND)\b[^\n]*\n)+)/g)].map(
    ([, where]) => where
  );
}

// The ledger is ordered by (event, toDate(time), ...), so only a scan whose time range is its own
// AND-ed bound is pruned by it. Daily rows (views) are nearly all of the ledger and only the
// recomputed days of them are read; an OR between the two ranges reads the whole season. CI has no
// ClickHouse, so this pins the shape: per scan, one range, and the daily scan's starts at recomputeFrom.
describe('referee ledger scans', () => {
  const DAILY = /^\s*AND has\(\{dailyTypes:Array\(String\)\}, type\)\s*$/m;
  const NOT_DAILY = /^\s*AND NOT has\(\{dailyTypes:Array\(String\)\}, type\)\s*$/m;

  it.each([
    ['referee', eventPointsRefereeSql],
    ['users', eventPointsRefereeUsersSql],
  ])('%s query reads daily rows only from the recomputed days, on the key column', (_, sql) => {
    const scans = ledgerScans(sql);
    for (const scan of scans) expect(scan).not.toMatch(/\bOR\b/);
    const daily = scans.filter((scan) => DAILY.test(scan));
    const rest = scans.filter((scan) => NOT_DAILY.test(scan));
    expect(daily).toHaveLength(1);
    expect(rest).toHaveLength(1);
    expect(scans).toHaveLength(2);
    expect(daily[0]).toMatch(/^\s*AND time >= \{recomputeFrom:DateTime64\(3\)\} AND time < \{/m);
    expect(rest[0]).toMatch(/^\s*AND time >= \{seasonStart:DateTime64\(3\)\} AND time < \{/m);
  });
});

// A whole-season settle (the nightly run, and every run once the season has ended) reads the whole
// ledger and needs far longer than an hourly one; an hourly one must not get that long.
describe('referee budget per window', () => {
  // deadline: ms from now.
  const firstQueryCap = async (now: Date, deadline?: number) => {
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    redisMock.sysRedis.get.mockResolvedValue(null);
    query.mockClear();
    query.mockRejectedValueOnce(new Error('stop'));
    // Frozen, so the whole seconds left are exact.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await expect(
        runEventPointsReferee(EVENT, 'live', now, deadline && Date.now() + deadline)
      ).rejects.toThrow('stop');
    } finally {
      vi.useRealTimers();
    }
    return (query.mock.calls[0]?.[0] as { clickhouse_settings?: { max_execution_time?: number } })
      .clickhouse_settings?.max_execution_time;
  };

  it('gives the nightly whole-season run the full budget', async () => {
    const now = new Date('2026-11-05T03:07:00.000Z');
    expect(refereeWindow(EVENT, 'live', now).full).toBe(true);
    expect(await firstQueryCap(now)).toBe(REFEREE_FULL_CLICKHOUSE_BUDGET_S);
  });

  it('gives a run after the season has ended the full budget', async () => {
    const now = new Date('2026-12-01T12:07:00.000Z');
    expect(refereeWindow(EVENT, 'live', now).full).toBe(true);
    expect(await firstQueryCap(now)).toBe(REFEREE_FULL_CLICKHOUSE_BUDGET_S);
  });

  it('gives an hourly run the hourly budget', async () => {
    const now = new Date('2026-11-05T12:07:00.000Z');
    expect(refereeWindow(EVENT, 'live', now).full).toBe(false);
    expect(await firstQueryCap(now)).toBe(REFEREE_CLICKHOUSE_BUDGET_S);
  });

  it("never runs past the job's own deadline", async () => {
    const now = new Date('2026-11-05T03:07:00.000Z');
    expect(await firstQueryCap(now, 100_500)).toBe(100);
  });
});

// Shadow point types (recorded for testers, scoring for nobody) share the ledger with real ones. Live
// weights apply to the whole season, so a type the config does not list must never be read: without
// this filter it writes zero-point snapshot rows, and once given a weight it would score retroactively.
// CI has no ClickHouse to run the SQL, so this pins both halves: the clause is an AND-ed, uncommented
// condition on the ledger scan of each query, and the caller binds it to exactly the config's types.
describe('referee reads only the scored types', () => {
  const FILTER = /^\s*AND has\(\{types:Array\(String\)\}, type\)\s*$/m;

  it.each([
    ['referee', eventPointsRefereeSql],
    ['users', eventPointsRefereeUsersSql],
  ])('%s query filters every ledger scan on the scoring types', (_, sql) => {
    const scans = ledgerScans(sql);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) expect(scan).toMatch(FILTER);
  });

  it('binds `types` to exactly the scoring config, never a type only the ledger has', async () => {
    redisMock.sysRedis.hGetAll.mockResolvedValue({ 'shadow:view': '5' });
    query.mockClear();
    const scored = {
      ...EVENT,
      scoring: {
        ...EVENT.scoring,
        types: {
          view: { weight: 1, once: 'day' as const, entities: ['Image' as const] },
          reaction: { weight: 5, once: 'event' as const, entities: ['Image' as const] },
        },
      },
    };
    await queryReferee(scored, refereeWindow(scored, 'live', new Date('2026-11-05T12:07:00.000Z')));
    expect(query).toHaveBeenCalledTimes(2);
    for (const [arg] of query.mock.calls)
      expect(arg.query_params?.types).toEqual(['view', 'reaction']);
  });
});
