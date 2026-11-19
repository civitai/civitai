import { describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() =>
  vi.fn(async (_arg: Record<string, unknown>) => ({ json: async () => [] }))
);
// The shared client is absent: the award read must go through the long-query client.
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  clickhouseLongQueries: { query },
}));

const { CLIENT_GRACE_S } = await import('~/server/events/points/clickhouse-limits');
const { CRUCIBLE_AWARD_QUERY_MAX_S, loadCrucibleTeamAwards } = await import(
  '~/server/events/scoring/crucible-team-awards'
);

// Both settles run this under the settle lock, after their own budgeted queries. The client's 300 s
// request_timeout is a socket idle timer, so an uncapped read of the season can hold the lock with
// nothing to stop it.
describe('loadCrucibleTeamAwards ledger read', () => {
  it('is capped on the server, kept alive past the idle timer, and abandoned by the client', async () => {
    query.mockClear();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await loadCrucibleTeamAwards(
      { name: 'birthday2026', startDate: new Date('2026-11-01T00:00:00.000Z') },
      new Date('2026-11-05T12:00:00.000Z')
    );
    expect(query).toHaveBeenCalledTimes(1);
    const arg = query.mock.calls[0][0] as {
      abort_signal?: unknown;
      clickhouse_settings?: Record<string, unknown>;
    };
    expect(arg.clickhouse_settings?.max_execution_time).toBe(CRUCIBLE_AWARD_QUERY_MAX_S);
    expect(CRUCIBLE_AWARD_QUERY_MAX_S).toBeLessThanOrEqual(5 * 60);
    expect(arg.clickhouse_settings?.send_progress_in_http_headers).toBe(1);
    expect(Number(arg.clickhouse_settings?.http_headers_progress_interval_ms)).toBeLessThan(
      300_000
    );
    // Given up by the client after the server's cap plus its grace, not at some other time.
    expect(timeout).toHaveBeenCalledWith((CRUCIBLE_AWARD_QUERY_MAX_S + CLIENT_GRACE_S) * 1000);
    expect(arg.abort_signal).toBe(timeout.mock.results.at(-1)?.value);
    timeout.mockRestore();
  });
});
