import { describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const query = vi.hoisted(() =>
  vi.fn(async (_arg: { query: string; query_params?: Record<string, unknown> }) => ({
    json: async () => [],
  }))
);
// The shared client is absent: every referee query must go through the long-query client.
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  clickhouseLongQueries: { query },
}));

const { queryReferee, REFEREE_CLICKHOUSE_BUDGET_S, refereeWindow, runEventPointsReferee } =
  await import('~/server/events/points/referee');
const { eventSeasonKeys, LIVE_BUCKET_MS } = await import('~/server/events/points/keys');
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
    stored({ cut: now.getTime() - 5 * 60 * 60 * 1000 });
    expect(await staleAlerts(EVENT, now)).toHaveLength(1);
  });

  // After the season ends only removals settle, so only removeCut shows a stuck settle.
  const FINALIZING = {
    ...EVENT,
    scoring: { ...EVENT.scoring, finalizeAfterMs: 24 * 60 * 60 * 1000 },
  };
  const END = FINALIZING.endDate.getTime();
  const HOUR = 60 * 60 * 1000;

  it('logs a settle stuck inside the finalize window, after the season has ended', async () => {
    stored({ cut: END, removeCut: END + HOUR });
    expect(await staleAlerts(FINALIZING, new Date(END + 5 * HOUR + 10 * 60_000))).toEqual([
      expect.objectContaining({ season: 'live', cutAgeMinutes: 240 }),
    ]);
  });

  it('stays quiet once the finalize window has been settled', async () => {
    stored({ cut: END, removeCut: END + 24 * HOUR });
    expect(await staleAlerts(FINALIZING, new Date(END + 30 * HOUR))).toEqual([]);
  });
});

// What resetLiveBase leaves in redis: the cut as a bucket number, the removal cut as ms.
function stored({ cut, removeCut }: { cut: number; removeCut?: number }) {
  redisMock.sysRedis.get.mockImplementation((async (key: string) => {
    const keys = eventSeasonKeys('e', 'live');
    if (key === keys.removeCut) return removeCut == null ? null : String(removeCut);
    if (key === keys.cut) return String(Math.ceil(cut / LIVE_BUCKET_MS));
    return null;
  }) as never);
}

// The failing query ends the run right after the alert, so only the alert is under test.
async function staleAlerts(event: typeof EVENT, now: Date) {
  redisMock.sysRedis.hGetAll.mockResolvedValue({});
  query.mockClear();
  query.mockRejectedValueOnce(new Error('Timeout exceeded'));
  loggingMock.logToAxiom.mockClear();
  await expect(runEventPointsReferee(event, 'live', now)).rejects.toThrow('Timeout exceeded');
  return loggingMock.logToAxiom.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .filter((entry) => entry.name === 'event-points-cut-stale');
}

// The WHERE of every scan of the ledger table, one per branch.
function ledgerScans(sql: string) {
  return [...sql.matchAll(/FROM event_point_events\s*\n((?:[ \t]*(?:WHERE|AND)\b[^\n]*\n)+)/g)].map(
    ([, where]) => where
  );
}

// The ledger is ordered by (event, toDate(time), ...), so a scan is pruned only by a time range that
// is its own AND-ed bound; an OR between the daily and non-daily ranges reads the whole season. CI
// has no ClickHouse, so this pins the query's shape.
describe('referee ledger scans', () => {
  const DAILY = /^\s*AND has\(\{dailyTypes:Array\(String\)\}, type\)\s*$/m;
  const NOT_DAILY = /^\s*AND NOT has\(\{dailyTypes:Array\(String\)\}, type\)\s*$/m;

  it.each([
    ['referee', eventPointsRefereeSql, 'removeCut'],
    ['users', eventPointsRefereeUsersSql, 'cut'],
  ])(
    '%s query reads daily rows only from the recomputed days, on the key column',
    (_, sql, end) => {
      // Every reference to the table is a scan the pattern below sees.
      expect(sql.match(/FROM event_point_events\b/g)).toHaveLength(2);
      const scans = ledgerScans(sql);
      expect(scans).toHaveLength(2);
      for (const scan of scans) {
        expect(scan).not.toMatch(/\bOR\b/i);
        expect(scan).toMatch(/^\s*WHERE event = \{event:String\}\s*$/m);
      }
      const daily = scans.filter((scan) => DAILY.test(scan));
      const rest = scans.filter((scan) => NOT_DAILY.test(scan));
      expect(daily).toHaveLength(1);
      expect(rest).toHaveLength(1);
      const range = (from: string) =>
        new RegExp(
          String.raw`^\s*AND time >= \{${from}:DateTime64\(3\)\} AND time < \{${end}:DateTime64\(3\)\}\s*$`,
          'm'
        );
      expect(daily[0]).toMatch(range('recomputeFrom'));
      expect(rest[0]).toMatch(range('seasonStart'));
    }
  );
});

// The hourly window grows with the season too, so every settle gets the budget a whole-season one
// needs, bounded by the deadline of the run holding the lock.
describe('referee budget', () => {
  // deadline: ms from now.
  const firstQuery = async (now: Date, deadline?: number) => {
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    redisMock.sysRedis.get.mockResolvedValue(null);
    query.mockClear();
    query.mockRejectedValueOnce(new Error('stop'));
    // Frozen, so the whole seconds left are exact.
    vi.useFakeTimers({ toFake: ['Date'] });
    let error: unknown;
    try {
      await runEventPointsReferee(EVENT, 'live', now, deadline && Date.now() + deadline).catch(
        (e: unknown) => (error = e)
      );
    } finally {
      vi.useRealTimers();
    }
    const arg = query.mock.calls[0]?.[0] as {
      query_id?: string;
      clickhouse_settings?: { max_execution_time?: number };
    };
    return { error, cap: arg.clickhouse_settings?.max_execution_time, queryId: arg.query_id };
  };

  it.each([
    ['the nightly whole-season run', '2026-11-05T03:07:00.000Z'],
    ['a run after the season has ended', '2026-12-01T12:07:00.000Z'],
    ['an hourly run', '2026-11-05T12:07:00.000Z'],
  ])('gives %s the whole budget', async (_, at) => {
    expect((await firstQuery(new Date(at))).cap).toBe(REFEREE_CLICKHOUSE_BUDGET_S);
  });

  it('never runs past the deadline of the run holding the lock', async () => {
    expect((await firstQuery(new Date('2026-11-05T03:07:00.000Z'), 100_500)).cap).toBe(100);
  });

  it('names the failed query, so the log can be joined to the node that ran it', async () => {
    const { error, queryId } = await firstQuery(new Date('2026-11-05T12:07:00.000Z'));
    expect(queryId).toMatch(/^event-points-referee:e:users:/);
    expect((error as Error).message).toBe(`stop (query_id ${queryId})`);
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
