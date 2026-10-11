import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/events', () => ({ eventEngine: {} }));
vi.mock('~/server/events/points/sync', () => ({ syncEventHats: vi.fn() }));

const { eventEngineLeaderboardUpdate } = await import('~/server/jobs/event-engine-work');
const { REFEREE_QUERY_MAX_SECONDS } = await import('~/server/events/points/referee');

describe('event-engine-leaderboard-update job', () => {
  // The winner is named by the first run after the finalize window closes, so a run every hour.
  it('runs hourly, on the hour', () => {
    expect(eventEngineLeaderboardUpdate.cron).toBe('0 * * * *');
  });

  // A whole-season referee run can outlast the scheduler's client timeout; releasing the lock on
  // that hang-up would let the retry start a second run beside it.
  it('holds a 15-minute lock across a scheduler disconnect', () => {
    expect(eventEngineLeaderboardUpdate.options).toMatchObject({
      lockExpiration: 15 * 60,
      keepLockOnDisconnect: true,
    });
    // The referee runs its two ClickHouse queries one after the other, inside this lock.
    expect(eventEngineLeaderboardUpdate.options.lockExpiration).toBeGreaterThan(
      2 * REFEREE_QUERY_MAX_SECONDS
    );
  });
});
