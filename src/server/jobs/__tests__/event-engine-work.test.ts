import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/events', () => ({ eventEngine: {} }));
vi.mock('~/server/events/points/sync', () => ({ syncEventHats: vi.fn() }));

const { eventEngineLeaderboardUpdate } = await import('~/server/jobs/event-engine-work');

describe('event-engine-leaderboard-update job', () => {
  // REMOVAL_CUTOFF_MS assumes a referee run at the top of every hour.
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
  });
});
