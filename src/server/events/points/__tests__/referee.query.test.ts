import { describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const query = vi.hoisted(() => vi.fn(async () => ({ json: async () => [] })));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { query } }));

const { queryReferee, REFEREE_QUERY_MAX_SECONDS, refereeWindow } = await import(
  '~/server/events/points/referee'
);
const { eventPointsRefereeSql, eventPointsRefereeUsersSql } = await import(
  '~/server/events/points/referee.sql'
);

const EVENT = {
  name: 'e',
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  scoring: { capPerActorPerOwnerPerDay: 50, types: {}, newAccountDays: 7, finalizeAfterMs: 0 },
};

// The ClickHouse client gives up at 300s (pinned in client-config-pins.test.ts); a server-side cap
// past that leaves a query running on the server after the client has given up on it.
describe('referee ClickHouse queries', () => {
  it('cap both queries under the client request timeout', async () => {
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    query.mockClear();
    const now = new Date('2026-11-05T12:07:00.000Z');
    await queryReferee(EVENT, refereeWindow(EVENT, 'live', now));

    const settingsFor = (sql: string) =>
      query.mock.calls.find(([arg]) => (arg as { query: string }).query === sql)?.[0] as
        | { clickhouse_settings?: { max_execution_time?: number } }
        | undefined;
    expect(query).toHaveBeenCalledTimes(2);
    for (const sql of [eventPointsRefereeUsersSql, eventPointsRefereeSql]) {
      expect(settingsFor(sql)?.clickhouse_settings?.max_execution_time).toBe(
        REFEREE_QUERY_MAX_SECONDS
      );
    }
    expect(REFEREE_QUERY_MAX_SECONDS).toBeLessThan(300);
  });
});

// Shadow point types (recorded for testers, scoring for nobody) share the ledger with real ones. Live
// weights apply to the whole season, so a type the config does not list must never be read: without
// this filter it writes zero-point snapshot rows, and once given a weight it would score retroactively.
// CI has no ClickHouse to run the SQL, so this pins both halves: the clause is an AND-ed, uncommented
// condition on the ledger scan of each query, and the caller binds it to exactly the config's types.
describe('referee reads only the scored types', () => {
  const FILTER = /^\s*AND has\(\{types:Array\(String\)\}, type\)\s*$/m;
  // The ledger scan: the seasonRows CTE of the referee, the whole of the users query.
  const ledgerScan = (sql: string) => /seasonRows AS \(([\s\S]*?)\n  \),/.exec(sql)?.[1] ?? sql;

  it.each([
    ['referee', eventPointsRefereeSql],
    ['users', eventPointsRefereeUsersSql],
  ])('%s query filters its ledger scan on the scoring types', (_, sql) => {
    expect(ledgerScan(sql)).toMatch(/FROM event_point_events/);
    expect(ledgerScan(sql)).toMatch(FILTER);
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
      expect((arg as { query_params: { types: string[] } }).query_params.types).toEqual([
        'view',
        'reaction',
      ]);
  });
});
