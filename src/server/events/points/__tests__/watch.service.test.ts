import { describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The watch endpoint's wiring: the event comes from the in-memory registry (with its finalize window),
 * a hat id is checked against the engine's hat map, and nothing else is read.
 */

const START = new Date(Date.now() - 60_000);
const END = new Date(Date.now() + 60_000);
const FINALIZE_MS = 24 * 60 * 60 * 1000;
vi.mock('~/server/events/load-events', () => ({
  loadEvents: async () => [
    {
      name: 'birthday2026',
      startDate: START,
      endDate: END,
      scoring: { finalizeAfterMs: FINALIZE_MS },
    },
    { name: 'unscored', startDate: START, endDate: END },
  ],
}));
const known = vi.hoisted(() => ({ isKnownHatTopic: vi.fn(async () => true) }));
vi.mock('~/server/events/points/award', () => known);
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => true,
  isEventPointsEnabledSync: () => true,
}));

const { markEventPointsWatched } = await import('~/server/events/points/watch.service');
const { eventPointKeys } = await import('~/server/events/points/keys');
const { WATCH_TTL_MS } = await import('~/server/events/points/watch');

describe('markEventPointsWatched', () => {
  it("marks with the event's finalize window and asks the engine about hat ids", async () => {
    const sys = redisMock.sysRedis;
    sys.zCard.mockResolvedValue(0);
    sys.zmScore.mockResolvedValue([null, null]);
    const hat = '00000000000000ab';
    expect(await markEventPointsWatched({ event: 'birthday2026', topics: ['teams', hat] })).toEqual(
      {
        marked: 2,
      }
    );
    expect(known.isKnownHatTopic).toHaveBeenCalledWith('birthday2026', hat);
    const key = eventPointKeys('birthday2026').watch;
    expect(sys.pExpireAt).toHaveBeenCalledWith(key, END.getTime() + FINALIZE_MS + WATCH_TTL_MS);
  });

  it('marks nothing for an event without scoring', async () => {
    expect(await markEventPointsWatched({ event: 'unscored', topics: ['teams'] })).toEqual({
      marked: 0,
    });
  });
});
