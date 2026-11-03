import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as TurfWatch from '~/server/events/turf/turf-watch';

const START = new Date('2026-11-01T00:00:00Z');
const EVENT = {
  name: 'e',
  startDate: START,
  endDate: new Date('2026-12-01T00:00:00Z'),
  teams: ['Blue', 'Pink'],
  scoring: { finalizeAfterMs: 0 },
  turf: {
    mode: 'live',
    testerFlag: 'e-turf',
    supply: [{ from: START, perHour: 5, cap: 50 }],
    creditedPlayers: [{ from: START, players: 25 }],
    renderLimit: 12,
    mapMaxEntries: 10,
  },
  getUserTeam: async () => 'Blue',
  getTeamCosmetic: async (team: string) => (team === 'Blue' ? 11 : 12),
};
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
const pushTurfCounts = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('~/server/events/turf/turf-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfWatch>()),
  pushTurfCounts,
}));

const { getTurfEvent, syncTurfImages } = await import('~/server/events/turf/turf.service');
const { computeImageTurf } = await import('~/server/events/turf/turf-map');

const NOW = new Date('2026-11-05T12:00:00Z');
const sticker = (imageId: number, userId: number, team: string) => ({
  imageId,
  userId,
  team,
  cosmeticId: team === 'Blue' ? 11 : 12,
  eligible: true,
  createdAt: new Date('2026-11-05T11:00:00Z'),
});

describe('syncTurfImages', () => {
  it('pushes counts only for the images whose counts changed', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    const unchanged = sticker(900, 5, 'Blue');
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([unchanged, sticker(901, 6, 'Pink')]);
    const stored = JSON.stringify(computeImageTurf([unchanged], 25, () => 11).counts);
    redisMock.sysRedis.hmGet
      .mockResolvedValueOnce([null, null]) // the map
      .mockResolvedValueOnce([stored, null]); // the counts: 900 as computed, 901 new

    await syncTurfImages(event, [900, 901], NOW);

    // Every place and remove syncs; an unchanged image must not wake its watchers.
    expect(pushTurfCounts).toHaveBeenCalledTimes(1);
    const [, pushed] = pushTurfCounts.mock.calls[0] as unknown as [string, { imageId: number }[]];
    expect(pushed.map((p) => p.imageId)).toEqual([901]);
  });
});
