import { Prisma } from '@prisma/client';
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

const { getTurfEvent, syncTurfImages, reconcileTurf, pickFeedStickers, getTurfStickersForImages } =
  await import('~/server/events/turf/turf.service');
const { computeImageTurf } = await import('~/server/events/turf/turf-map');

const NOW = new Date('2026-11-05T12:00:00Z');
const sticker = (imageId: number, userId: number, team: string) => ({
  imageId,
  id: BigInt(userId),
  data: { x: 0.5, y: 0.5 },
  drawable: true,
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

const visibleOf = (sql: string) =>
  sql.slice(sql.indexOf(' p."publishedAt"'), sql.indexOf('"blockedFor" IS NULL'));
const sqlOf = (call: unknown[]) => {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values).sql.replace(/\s+/g, ' ');
};

// A push carries pickFeedStickers' pick in place of a viewer reading getTurfStickersForImages, so
// the two must pick the same hats. Parity is pinned by this fixture and the SQL text, not a database.
describe('the stickers a turf push carries', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 5, h));
  const row = (id: number, team: string, hour: number, drawable = true) => ({
    id: BigInt(id),
    userId: 100 + id,
    team,
    cosmeticId: team === 'Blue' ? 11 : 12,
    data: { x: 0.1 * id, y: 0.5 },
    createdAt: at(hour),
    drawable,
  });
  // Oldest first, as liveStickers returns them.
  const rows = [
    row(7, 'Blue', 0),
    row(1, 'Blue', 1),
    row(4, 'Pink', 1),
    row(2, 'Blue', 2),
    row(3, 'Blue', 3),
    row(6, 'Blue', 3),
    row(5, 'Pink', 4, false), // a banned or deleted placer: never drawn
  ];

  it('picks each team’s newest first, then the next newest, drawable only, five at most', () => {
    // teamRank 1: Blue 6 (newest, id beats 3 at the same time), Pink 4; then Blue 3, 2, 1; Blue 7 is
    // sixth. Pink 5 is newest of all but not drawable.
    expect(pickFeedStickers(rows).map((s) => s.id)).toEqual(['6', '4', '3', '2', '1']);
    expect(pickFeedStickers(rows)[0]).toEqual({
      id: '6',
      userId: 106,
      team: 'Blue',
      cosmeticId: 11,
      data: { x: 0.1 * 6, y: 0.5 },
    });
  });

  it('ranks and filters in the same SQL the feed read uses', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    await getTurfStickersForImages(event.name, [900], 5);
    const read = sqlOf(dbMock.dbRead.$queryRaw.mock.calls.at(-1)!);
    expect(read).toContain(
      'row_number() OVER (PARTITION BY s."imageId", s.team ORDER BY s."createdAt" DESC, s.id DESC)'
    );
    expect(read).toContain('PARTITION BY "imageId" ORDER BY "teamRank", "createdAt" DESC, id DESC');
    // The whole filter, so a rule added to the read alone (which a push would not apply) fails here.
    const where = read.slice(read.indexOf(' WHERE s.event'), read.indexOf(' ), picked'));
    expect(where).toBe(
      ' WHERE s.event = ? AND s."imageId" = ANY(?::int[]) AND s."removedAt" IS NULL AND' +
        visibleOf(read) +
        '"blockedFor" IS NULL AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL'
    );

    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]);
    redisMock.sysRedis.hmGet.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await syncTurfImages(event, [900], NOW);
    const live = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls.at(-1)!);
    expect(live).toContain('(u."bannedAt" IS NULL AND u."deletedAt" IS NULL) AS drawable');
    expect(live).toContain('s."removedAt" IS NULL');
    // The same image visibility rule on both reads.
    expect(visibleOf(live)).not.toBe('');
    expect(visibleOf(live)).toBe(visibleOf(read));
  });

  it('rides on the push a placement sends, with no extra read', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    pushTurfCounts.mockClear();
    dbMock.dbWrite.$queryRaw.mockClear();
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(
      rows.map((r) => ({ ...r, imageId: 900, eligible: true }))
    );
    redisMock.sysRedis.hmGet.mockResolvedValueOnce([null]).mockResolvedValueOnce([null]);

    await syncTurfImages(event, [900], NOW);

    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    const [, pushed] = pushTurfCounts.mock.calls[0] as unknown as [
      string,
      { imageId: number; stickers: { id: string }[]; readAt: number }[]
    ];
    expect(pushed[0].stickers.map((s) => s.id)).toEqual(['6', '4', '3', '2', '1']);
    expect(pushed[0].readAt).toBe(NOW.getTime());
  });
});

describe('reconcileTurf', () => {
  it('carries stickers for changed images, and none it did not pick (watchers read those back)', async () => {
    const event = (await getTurfEvent('e', NOW))!;
    pushTurfCounts.mockClear();
    const a = { ...sticker(900, 5, 'Blue'), eligible: true };
    const b = { ...sticker(901, 6, 'Pink'), eligible: true };
    const bCounts = JSON.stringify(computeImageTurf([b], 25, () => 12).counts);
    dbMock.dbRead.$queryRaw
      .mockResolvedValueOnce([{ imageId: 900 }, { imageId: 901 }])
      .mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([]);
    redisMock.sysRedis.hGetAll
      .mockResolvedValueOnce({ 'Image:901': bCounts }) // before the read: 900 changed, 901 not
      .mockResolvedValueOnce({}) // the map
      .mockResolvedValueOnce({ 'Image:901': 'moved since' }); // after it: both differ

    await reconcileTurf(event, NOW);

    const [, pushed] = pushTurfCounts.mock.calls[0] as unknown as [
      string,
      { imageId: number; stickers?: { id: string }[] }[]
    ];
    const byId = Object.fromEntries(pushed.map((p) => [p.imageId, p]));
    expect(byId[900].stickers?.map((s) => s.id)).toEqual(['5']);
    // Never [] here: that would draw an image that has hats as having none.
    expect(byId[901]).toBeDefined();
    expect(byId[901].stickers).toBeUndefined();
  });
});
