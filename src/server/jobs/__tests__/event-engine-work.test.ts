import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/events', () => ({ eventEngine: {} }));
vi.mock('~/server/events/points/sync', () => ({ syncEventHats: vi.fn() }));

const { eventEngineLeaderboardUpdate } = await import('~/server/jobs/event-engine-work');
const { REFEREE_CLICKHOUSE_BUDGET_S, SETTLE_LOCK_S } = await import(
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
    // A whole-season settle read ~1.6 s per million ledger rows in November 2026, projecting to
    // about 22 minutes by the end of a month-long event.
    expect(REFEREE_CLICKHOUSE_BUDGET_S).toBeGreaterThanOrEqual(30 * 60);
    expect(SETTLE_LOCK_S - REFEREE_CLICKHOUSE_BUDGET_S).toBeGreaterThanOrEqual(5 * 60);
    expect(SETTLE_LOCK_S).toBeLessThan(60 * 60);
  });
});
