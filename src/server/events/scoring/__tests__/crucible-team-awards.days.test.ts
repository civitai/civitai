import { describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() =>
  vi.fn(async (_arg: Record<string, unknown>) => ({ json: async () => [] }))
);
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  clickhouseLongQueries: { query },
}));

const {
  crucibleAwardDays,
  crucibleTeamAwardLedgerRow,
  crucibleTeamAwardRowsSql,
  isCrucibleTeamAwardRowsSql,
  loadCrucibleTeamAwards,
} = await import('~/server/events/scoring/crucible-team-awards');

describe('crucibleAwardDays', () => {
  it('runs from the season start day through the later of now and until, across a month end', () => {
    expect(
      crucibleAwardDays(
        new Date('2026-10-30T15:00:00.000Z'),
        new Date('2026-11-01T12:00:00.000Z'),
        new Date('2026-11-02T01:00:00.000Z')
      )
    ).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(
      crucibleAwardDays(
        new Date('2026-11-01T00:00:00.000Z'),
        new Date('2026-11-03T00:00:00.000Z'),
        new Date('2026-11-01T09:00:00.000Z')
      )
    ).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });
});

// The ledger is ordered by (event, toDate(time), ownerId, ...). On prod, one day's award read selected
// 31 granules with `ownerId = 0` after an exact day, 947 without, and a day range or set of days
// dropped ownerId from the key condition and read the season. CI has no ClickHouse, so this pins the
// shape, and that the writer puts every award row where the reader looks.
describe('crucibleTeamAwardRowsSql', () => {
  it('scans each day on an exact day and ownerId 0', () => {
    const sql = crucibleTeamAwardRowsSql(3);
    expect(isCrucibleTeamAwardRowsSql(sql)).toBe(true);
    const scans = sql.split('\nUNION ALL\n');
    expect(scans).toHaveLength(3);
    expect(sql.match(/FROM event_point_events\b/g)).toHaveLength(3);
    scans.forEach((scan, i) => {
      expect(scan).toMatch(/^\s*WHERE event = \{event:String\}\s*$/m);
      expect(scan).toMatch(
        new RegExp(String.raw`^\s*AND toDate\(time\) = \{day${i}:Date\}\s*$`, 'm')
      );
      expect(scan).toMatch(/^\s*AND ownerId = 0\s*$/m);
      expect(scan).toMatch(/^\s*AND type = \{type:String\}\s*$/m);
      expect(scan).toMatch(/^\s*AND time >= \{seasonStart:DateTime64\(3\)\}\s*$/m);
      expect(scan).not.toMatch(/\bOR\b|\bIN\b/i);
    });
  });

  it('reads where the writer writes: every award row has ownerId 0', () => {
    const entry = { entryId: 1, crucibleId: 2, userId: 3 };
    for (const op of ['add', 'remove'] as const)
      expect(crucibleTeamAwardLedgerRow('e', op, entry, new Date(), 'Blue').ownerId).toBe(0);
  });

  it('sends no query before the season has a day to read', async () => {
    query.mockClear();
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    expect(
      await loadCrucibleTeamAwards({ name: 'birthday2026', startDate: start }, new Date())
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('binds one day per scan, through until when until is ahead of now', async () => {
    query.mockClear();
    const until = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await loadCrucibleTeamAwards({ name: 'birthday2026', startDate: start }, until);
    const arg = query.mock.calls[0][0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    const days = crucibleAwardDays(start, until);
    expect(days.length).toBeGreaterThanOrEqual(4);
    expect(arg.query).toBe(crucibleTeamAwardRowsSql(days.length));
    days.forEach((day, i) => expect(arg.query_params[`day${i}`]).toBe(day));
    expect(arg.query_params[`day${days.length}`]).toBeUndefined();
  });
});
