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

const { placeTurfSticker, getTurfStickers } = await import('~/server/events/turf/turf.service');

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
  image: { ownerId: number; visible: boolean; ownerActive: boolean; ownerAllows: boolean } | null,
  stock?: number
) {
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce([placer])
    .mockResolvedValueOnce(image ? [image] : [])
    .mockResolvedValueOnce(stock === undefined ? [] : [{ stock, refilledAt: NOW }]);
}
const OK_PLACER = { optedIn: true, team: 'Blue' };
const OK_IMAGE = { ownerId: 77, visible: true, ownerActive: true, ownerAllows: true };

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
    ['the placer has not opted in', { optedIn: false, team: 'Blue' }, OK_IMAGE, /Join Hat Turf/],
    [
      "the placer doesn't own that hat",
      { optedIn: true, team: null },
      OK_IMAGE,
      /don't have that hat/,
    ],
    // The hat art is the sticker: a Pink hat scoring for Blue would show one team and count another.
    ["the hat is another team's", { optedIn: true, team: 'Pink' }, OK_IMAGE, /isn't your team's/],
    [
      "the image isn't publicly visible",
      OK_PLACER,
      { ...OK_IMAGE, visible: false },
      /published post/,
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

  // Robustness: a hat whose team is spelled in another case still counts as the player's team.
  it("places a hat whose team differs from the player's only in case", async () => {
    given({ optedIn: true, team: 'blue' }, OK_IMAGE, 3);
    await placeTurfSticker(input, NOW);
    expect(dbMock.dbWrite.eventTurfSticker.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ team: 'Blue' }),
    });
  });

  it('a second sticker on the same image is refused by the unique key, in words', async () => {
    given(OK_PLACER, OK_IMAGE, 3);
    dbMock.dbWrite.eventTurfSticker.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })
    );
    await expect(placeTurfSticker(input, NOW)).rejects.toThrow(/already put a hat sticker/);
  });
});

describe('getTurfStickers paging', () => {
  const LIMIT = EVENT.turf.renderLimit;
  // Newest first, as the query orders them: ids LIMIT+1 down to 1, a minute apart.
  const drawn = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: BigInt(n - i),
      userId: 1,
      team: 'Blue',
      cosmeticId: 11,
      data: {},
      createdAt: new Date(NOW.getTime() - i * 60_000),
    }));
  const queries = () =>
    dbMock.dbRead.$queryRaw.mock.calls.map(([strings, ...values]) =>
      Prisma.sql(strings as TemplateStringsArray, ...values)
    );

  // Stands in for Postgres: returns `rows` up to the query's own LIMIT, its last parameter.
  const serve = (rows: ReturnType<typeof drawn>) =>
    dbMock.dbRead.$queryRaw.mockImplementationOnce(((
      strings: TemplateStringsArray,
      ...v: unknown[]
    ) => Promise.resolve(rows.slice(0, Number(Prisma.sql(strings, ...v).values.at(-1))))) as never);

  beforeEach(() => dbMock.dbRead.$queryRaw.mockReset());

  it('hands back a cursor at the last sticker drawn when more are older', async () => {
    const rows = drawn(LIMIT + 5);
    serve(rows);
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    const { stickers, nextCursor } = await getTurfStickers('e', 900, PLACER);
    expect(stickers).toHaveLength(LIMIT);
    expect(nextCursor).toEqual({
      createdAt: rows[LIMIT - 1].createdAt.toISOString(),
      id: rows[LIMIT - 1].id.toString(),
    });
  });

  it('no cursor once the oldest sticker is on the page', async () => {
    serve(drawn(LIMIT));
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    expect((await getTurfStickers('e', 900, PLACER)).nextCursor).toBeNull();
  });

  it('serves the draw ceiling, 24 when the event sets none', async () => {
    serve(drawn(LIMIT));
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    expect((await getTurfStickers('e', 900, PLACER)).drawCeiling).toBe(24);
  });

  it('a later page asks only for stickers older than the cursor, and not for mine', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    const before = { createdAt: '2026-11-05T11:00:00.123Z', id: BigInt(4242) };
    const { mine } = await getTurfStickers('e', 900, PLACER, before);
    expect(mine).toBeNull();
    const [page, ...rest] = queries();
    expect(rest).toHaveLength(0);
    // Without this bound every page repeats the first one.
    expect(page.text).toMatch(/\(s\."createdAt", s\.id\) < \(\$\d+::timestamptz, \$\d+::bigint\)/);
    expect(page.values).toContainEqual(new Date(before.createdAt));
    expect(page.values).toContain(BigInt(4242));
  });
});
