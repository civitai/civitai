import { describe, expect, it, vi } from 'vitest';
import type * as Enabled from '~/server/events/points/enabled';

vi.mock('~/server/events/points/enabled', async (importOriginal) => ({
  ...(await importOriginal<typeof Enabled>()),
  isEventPointsEnabled: async () => true,
}));

const { MAX_TURF_WATCHED, markTurfWatched, pushTurfCounts } = await import(
  '~/server/events/turf/turf-watch'
);

const NOW = 1_000_000;
const EVENT = { name: 'e', endsAt: new Date(NOW + 60_000) };

// A sorted set with real ZADD / ZMSCORE / ZCARD semantics: the cap and the lapse are the behaviour.
function fakeZset(seed: [string, number][] = []) {
  const z = new Map(seed);
  return {
    z,
    redis: {
      async zRemRangeByScore(_key: string, _min: string, max: number) {
        for (const [m, s] of z) if (s <= max) z.delete(m);
        return 0;
      },
      async zCard() {
        return z.size;
      },
      async zmScore(_key: string, members: string[]) {
        return members.map((m) => z.get(m) ?? null);
      },
      async zAdd(_key: string, items: { score: number; value: string }[]) {
        for (const { score, value } of items) z.set(value, score);
        return items.length;
      },
      async pExpireAt() {
        return true;
      },
    },
  };
}

describe('markTurfWatched', () => {
  it('refreshes images already marked even when the set is full, and refuses new ones', async () => {
    const full: [string, number][] = Array.from({ length: MAX_TURF_WATCHED }, (_, i) => [
      String(i + 1),
      NOW + 10,
    ]);
    const { z, redis } = fakeZset(full);
    const marked = await markTurfWatched(EVENT, [1, 999_999_999], {
      redis: redis as never,
      now: NOW,
    });
    expect(marked).toBe(1);
    expect(z.has('999999999')).toBe(false);
    expect(z.get('1')).toBeGreaterThan(NOW + 10);
  });

  it('marks nothing once the event is over', async () => {
    const { z, redis } = fakeZset();
    expect(await markTurfWatched(EVENT, [5], { redis: redis as never, now: NOW + 120_000 })).toBe(
      0
    );
    expect(z.size).toBe(0);
  });
});

describe('pushTurfCounts', () => {
  it('sends only the images someone is still watching', async () => {
    const { redis } = fakeZset([
      ['10', NOW + 5_000],
      ['11', NOW - 1],
    ]);
    const send = vi.fn(async () => undefined);
    const counts = {
      shown: { Blue: 1 },
      counted: { Blue: 1 },
      leader: 'Blue',
      leaderCosmeticId: 7,
    };
    await pushTurfCounts(
      'e',
      [
        { imageId: 10, counts, stickers: [] },
        { imageId: 11, counts, stickers: [] },
        { imageId: 12, counts: null, stickers: [] },
      ],
      { redis: redis as never, send, now: NOW }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: expect.stringMatching(/:e:turf:10$/),
        data: { event: 'e', imageId: 10, counts, stickers: [] },
      })
    );
  });
});
