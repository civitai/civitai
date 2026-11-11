import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/events', () => ({ eventEngine: {} }));
vi.mock('~/server/events/points/sync', () => ({ syncEventHats: vi.fn() }));

const { eventEngineLeaderboardUpdate } = await import('~/server/jobs/event-engine-work');
const { REFEREE_FULL_CLICKHOUSE_BUDGET_S, SETTLE_LOCK_S } = await import(
  '~/server/events/points/referee'
);

describe('event-engine-leaderboard-update job', () => {
  // The winner is named by the first run after the finalize window closes, so a run every hour.
  it('runs hourly, on the hour', () => {
    expect(eventEngineLeaderboardUpdate.cron).toBe('0 * * * *');
  });

  // A whole-season referee run can outlast the scheduler's client timeout; releasing the lock on
  // that hang-up would let the retry start a second run beside it.
  it('holds the settle lock across a scheduler disconnect', () => {
    expect(eventEngineLeaderboardUpdate.options).toMatchObject({
      lockExpiration: SETTLE_LOCK_S,
      keepLockOnDisconnect: true,
    });
    // Room after a whole-season settle's ClickHouse time for the sync and the writes, and released
    // before the next hour's run.
    expect(SETTLE_LOCK_S - REFEREE_FULL_CLICKHOUSE_BUDGET_S).toBeGreaterThanOrEqual(5 * 60);
    expect(SETTLE_LOCK_S).toBeLessThan(60 * 60);
  });
});
