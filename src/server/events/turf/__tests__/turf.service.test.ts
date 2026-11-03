import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';

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
  getTeamCosmetic: async () => 11,
};
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
const assertCanPlace = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  assertCanPlace,
}));

const { placeTurfSticker } = await import('~/server/events/turf/turf.service');

const NOW = new Date('2026-11-05T12:00:00Z');
const PLACER = 5;
const input = {
  event: 'e',
  userId: PLACER,
  imageId: 900,
  cosmeticId: 11,
  data: { x: 0.5, y: 0.5, scale: 1, rotation: 0, flip: false },
};

// The placer row, then the image row, as placeTurfSticker reads them before its transaction.
function given(
  placer: { optedIn: boolean; team: string | null },
  image: { ownerId: number; visible: boolean; ownerOptedIn: boolean } | null,
  stock?: number
) {
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce([placer])
    .mockResolvedValueOnce(image ? [image] : [])
    .mockResolvedValueOnce(stock === undefined ? [] : [{ stock, refilledAt: NOW }]);
}
const OK_PLACER = { optedIn: true, team: 'Blue' };
const OK_IMAGE = { ownerId: 77, visible: true, ownerOptedIn: true };

// The UPDATE that spends a sticker, with the stock it writes.
const spent = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map(([sql, ...values]) => ({ sql: (sql as TemplateStringsArray).join('?'), values }))
    .filter(({ sql }) => sql.includes('UPDATE "EventTurfStock"'));

describe('placeTurfSticker', () => {
  beforeEach(() => {
    // Queued answers must not leak from a test that refused early into the next one.
    dbMock.dbWrite.$queryRaw.mockReset();
    dbMock.dbWrite.eventTurfSticker.create.mockReset();
    dbMock.dbWrite.$executeRaw.mockReset();
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  });

  it.each([
    [
      'the placer has not opted in',
      { optedIn: false, team: 'Blue' },
      OK_IMAGE,
      /accept team hat stickers/,
    ],
    [
      "the placer doesn't own that hat",
      { optedIn: true, team: null },
      OK_IMAGE,
      /don't have that hat/,
    ],
    [
      "the image isn't publicly visible",
      OK_PLACER,
      { ...OK_IMAGE, visible: false },
      /published post/,
    ],
    [
      "the owner hasn't opted in",
      OK_PLACER,
      { ...OK_IMAGE, ownerOptedIn: false },
      /doesn't accept/,
    ],
  ])('refuses when %s, spending nothing', async (_, placer, image, message) => {
    given(placer, image, 10);
    await expect(placeTurfSticker(input, NOW)).rejects.toThrow(message);
    expect(dbMock.dbWrite.eventTurfSticker.create).not.toHaveBeenCalled();
    expect(spent()).toHaveLength(0);
  });

  it('refuses a placer the owner blocked, or a suspended one, spending nothing', async () => {
    given(OK_PLACER, OK_IMAGE, 10);
    assertCanPlace.mockRejectedValueOnce(new Error('placement: blocked'));
    await expect(placeTurfSticker(input, NOW)).rejects.toThrow(/can't put hat stickers/);
    expect(dbMock.dbWrite.eventTurfSticker.create).not.toHaveBeenCalled();
  });

  it('lets an owner sticker their own image', async () => {
    given(OK_PLACER, { ...OK_IMAGE, ownerId: PLACER }, 3);
    await placeTurfSticker(input, NOW);
    expect(dbMock.dbWrite.eventTurfSticker.create).toHaveBeenCalled();
  });

  it('refuses with less than one whole sticker left', async () => {
    given(OK_PLACER, OK_IMAGE, 0.5);
    // Stocked at 0.5 just now: no time has passed to refill it.
    await expect(placeTurfSticker(input, NOW)).rejects.toThrow(/Out of hat stickers/);
    expect(dbMock.dbWrite.eventTurfSticker.create).not.toHaveBeenCalled();
  });

  it('records where the placement started, for the experiment readout', async () => {
    given(OK_PLACER, OK_IMAGE, 3);
    await placeTurfSticker({ ...input, source: 'feed' }, NOW);
    expect(dbMock.dbWrite.eventTurfSticker.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ data: expect.objectContaining({ x: 0.5, source: 'feed' }) }),
    });
  });

  it('places the sticker and spends exactly one', async () => {
    given(OK_PLACER, OK_IMAGE, 3);
    await placeTurfSticker(input, NOW);
    expect(dbMock.dbWrite.eventTurfSticker.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'e', imageId: 900, userId: PLACER, team: 'Blue' }),
    });
    expect(spent()).toHaveLength(1);
    expect(spent()[0].values[0]).toBe(2);
  });

  it('a second sticker on the same image is refused by the unique key, in words', async () => {
    given(OK_PLACER, OK_IMAGE, 3);
    dbMock.dbWrite.eventTurfSticker.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })
    );
    await expect(placeTurfSticker(input, NOW)).rejects.toThrow(/already put a hat sticker/);
  });
});
