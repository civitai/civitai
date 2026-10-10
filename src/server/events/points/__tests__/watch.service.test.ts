import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The watch endpoint's wiring: the event comes from the in-memory registry (with its finalize window
 * and preview start), a hat id is checked against the engine's hat map, the preview's access comes
 * from the event's own gate for this viewer, and nothing else is read.
 */

const START = new Date(Date.now() - 60_000);
const END = new Date(Date.now() + 60_000);
const FINALIZE_MS = 24 * 60 * 60 * 1000;
const PREVIEWING = {
  name: 'previewing',
  featureFlag: 'some-flag',
  previewFrom: new Date(Date.now() - 60_000),
  startDate: new Date(Date.now() + 60 * 60_000),
  endDate: new Date(Date.now() + 2 * 60 * 60_000),
  scoring: { finalizeAfterMs: FINALIZE_MS },
};
vi.mock('~/server/events/load-events', () => ({
  loadEvents: async () => [
    {
      name: 'birthday2026',
      startDate: START,
      endDate: END,
      scoring: { finalizeAfterMs: FINALIZE_MS },
    },
    { name: 'unscored', startDate: START, endDate: END },
    PREVIEWING,
  ],
}));
const known = vi.hoisted(() => ({ isKnownHatTopic: vi.fn(async () => true) }));
vi.mock('~/server/events/points/award', () => known);
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => true,
  isEventPointsEnabledSync: () => true,
}));
const access = vi.hoisted(() => ({ getEventAccess: vi.fn() }));
vi.mock('~/server/events/event-access', () => access);

const { markEventPointsWatched } = await import('~/server/events/points/watch.service');
const { eventPointKeys, previewTopicId } = await import('~/server/events/points/keys');
const { WATCH_TTL_MS } = await import('~/server/events/points/watch');

const sys = redisMock.sysRedis;
beforeEach(() => {
  vi.clearAllMocks();
  sys.zCard.mockResolvedValue(0);
  sys.zmScore.mockResolvedValue([null, null]);
});

describe('markEventPointsWatched', () => {
  it("marks with the event's finalize window and asks the engine about hat ids", async () => {
    const hat = '00000000000000ab';
    expect(
      await markEventPointsWatched({ event: 'birthday2026', topics: ['teams', hat] }, undefined)
    ).toEqual({ marked: 2 });
    expect(known.isKnownHatTopic).toHaveBeenCalledWith('birthday2026', hat, 'live');
    const key = eventPointKeys('birthday2026').watch;
    expect(sys.pExpireAt).toHaveBeenCalledWith(key, END.getTime() + FINALIZE_MS + WATCH_TTL_MS);
    // Live: nobody's access is asked.
    expect(access.getEventAccess).not.toHaveBeenCalled();
  });

  it('marks nothing for an event without scoring', async () => {
    expect(
      await markEventPointsWatched({ event: 'unscored', topics: ['teams'] }, undefined)
    ).toEqual({ marked: 0 });
  });

  it("in the preview, asks the event's gate about this viewer, and marks only if it says preview", async () => {
    const viewer = { id: 5 };
    const teams = previewTopicId('previewing', 'teams');
    const call = () => markEventPointsWatched({ event: 'previewing', topics: [teams] }, viewer);
    access.getEventAccess.mockResolvedValue('closed');
    expect(await call()).toEqual({ marked: 0 });
    expect(access.getEventAccess).toHaveBeenCalledWith(PREVIEWING, viewer);
    expect(sys.zAdd).not.toHaveBeenCalled();
    access.getEventAccess.mockResolvedValue('preview');
    expect(await call()).toEqual({ marked: 1 });
    expect(sys.zAdd).toHaveBeenCalledWith(eventPointKeys('previewing').watch, [
      { score: expect.any(Number), value: teams },
    ]);
  });
});
