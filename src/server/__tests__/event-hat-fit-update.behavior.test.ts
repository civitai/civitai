import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { updateEventHatFitSchema } from '~/server/schema/cosmetic.schema';
import { HAT_FIT_LIMITS } from '~/shared/constants/event-decoration.constants';

// A moderator's hat edit is one hand-written UPDATE that merges the new fields into the stored
// fit. This runs the statement the service builds against real Postgres, because only that can
// show the merge keeps the art's measured shape.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const db = dbMock.dbWrite;

db.$queryRaw.mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  const { rows } = await holder.db.query(flat.text, flat.values as unknown[]);
  return rows;
}) as never);

const caches = vi.hoisted(() => {
  const cache = () => ({ refresh: vi.fn(), fetch: vi.fn().mockResolvedValue({}) });
  const perEntity = () =>
    Object.fromEntries(['Model', 'Image', 'Article', 'Post', 'Model3D'].map((e) => [e, cache()]));
  return {
    cosmeticCache: cache(),
    cosmeticEntityCaches: perEntity(),
    eventDecorationEntityCaches: perEntity(),
    refreshOwnedStickerCache: vi.fn(),
    userCosmeticCache: cache(),
    userOwnedStickerCache: cache(),
  };
});
vi.mock('~/server/redis/caches', () => caches);
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  articlesSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));

const { updateEventHatFit } = await import('~/server/services/cosmetic.service');

const HAT_ID = 1;
const SHAPE = {
  canvas: [128, 160],
  bounds: [13, 25, 115, 152],
  brim: [17, 111, 136],
  outline: [
    [10, 136.6],
    [46.69, 36.07],
    [60.3, 22.46],
    [118, 136.6],
  ],
};
const HAT = { type: 'hat', event: 'birthday2026', url: 'hat.png', team: 'Blue', fit: SHAPE };

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, data jsonb NOT NULL, "updatedAt" timestamp(3));
  `);
});

async function seed(id: number, data: unknown) {
  await holder.db.query(`INSERT INTO "Cosmetic" (id, data) VALUES ($1, $2)`, [
    id,
    JSON.stringify(data),
  ]);
}
async function stored(id: number) {
  const { rows } = await holder.db.query<{ data: Record<string, unknown> }>(
    `SELECT data FROM "Cosmetic" WHERE id = $1`,
    [id]
  );
  return rows[0].data;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.db.exec(`DELETE FROM "Cosmetic"`);
  db.userCosmetic.findMany.mockResolvedValue([]);
});

// 🔴 To whoever simplifies this to a read, a spread and a Prisma update: the stored fit carries the
// art's measured outline, which the editor never sends. A whole-object write from the editor's
// view would wipe it, and the hat would be sized and clipped by its bounding box instead.
describe('saving a hat edit in Postgres', () => {
  it('a tilt save keeps the outline and every other field', async () => {
    await seed(HAT_ID, HAT);
    await updateEventHatFit({ id: HAT_ID, fit: { tilt: -30 } });
    expect(await stored(HAT_ID)).toEqual({ ...HAT, fit: { ...SHAPE, tilt: -30 } });
  });

  it('keeps fields set by an earlier save', async () => {
    await seed(HAT_ID, { ...HAT, fit: { ...SHAPE, grow: 1.2 } });
    await updateEventHatFit({ id: HAT_ID, fit: { offset: [3, -4] } });
    expect(await stored(HAT_ID)).toEqual({ ...HAT, fit: { ...SHAPE, grow: 1.2, offset: [3, -4] } });
  });

  it('puts a field back to the default look when it is cleared', async () => {
    await seed(HAT_ID, { ...HAT, fit: { ...SHAPE, depth: 0.3, size: 50 } });
    await updateEventHatFit({ id: HAT_ID, fit: { depth: null } });
    expect(await stored(HAT_ID)).toEqual({ ...HAT, fit: { ...SHAPE, size: 50 } });
  });

  it('starts a fit for a hat that has none', async () => {
    const { fit: _, ...bare } = HAT;
    await seed(HAT_ID, bare);
    await updateEventHatFit({ id: HAT_ID, fit: { size: 48 } });
    expect(await stored(HAT_ID)).toEqual({ ...bare, fit: { size: 48 } });
  });

  it.each([
    ['a frame', { url: 'frame.png', offsets: { top: 1 } }],
    ['a decoration of another kind', { ...HAT, type: 'scarf' }],
    ['a hat that belongs to no event', { type: 'hat', url: 'hat.png' }],
  ])('refuses %s and leaves it untouched', async (_, data) => {
    await seed(HAT_ID, data);
    await expect(updateEventHatFit({ id: HAT_ID, fit: { tilt: -30 } })).rejects.toThrow(
      /Only an event hat/
    );
    expect(await stored(HAT_ID)).toEqual(data);
  });

  it('refreshes the hat and every card wearing it, in batches', async () => {
    await seed(HAT_ID, HAT);
    const images = Array.from({ length: 1001 }, (_, i) => ({
      equippedToId: i + 1,
      equippedToType: 'Image',
    }));
    db.userCosmetic.findMany.mockResolvedValue([
      ...images,
      { equippedToId: 9, equippedToType: 'Article' },
    ]);

    await updateEventHatFit({ id: HAT_ID, fit: { tilt: -30 } });

    expect(db.userCosmetic.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cosmeticId: HAT_ID, equippedToId: { not: null } } })
    );
    expect(caches.cosmeticCache.refresh).toHaveBeenCalledWith([HAT_ID]);
    const imageRefresh = caches.eventDecorationEntityCaches.Image.refresh;
    expect(imageRefresh.mock.calls.map(([ids]) => ids.length)).toEqual([1000, 1]);
    expect(imageRefresh.mock.calls.flatMap(([ids]) => ids)).toEqual(
      images.map((x) => x.equippedToId)
    );
    expect(caches.eventDecorationEntityCaches.Article.refresh).toHaveBeenCalledWith([9]);
  });
});

describe('what a hat edit may contain', () => {
  const parse = (fit: unknown) => updateEventHatFitSchema.safeParse({ id: HAT_ID, fit }).success;

  it('accepts each setting at both ends of its range, and a cleared one', () => {
    for (const [key, [lo, hi]] of Object.entries(HAT_FIT_LIMITS)) {
      const at = (x: number) => (key === 'offset' ? [x, x] : x);
      expect(parse({ [key]: at(lo) }), `${key} ${lo}`).toBe(true);
      expect(parse({ [key]: at(hi) }), `${key} ${hi}`).toBe(true);
      expect(parse({ [key]: null }), `${key} null`).toBe(true);
    }
  });

  it('refuses each setting just outside its range', () => {
    for (const [key, [lo, hi]] of Object.entries(HAT_FIT_LIMITS)) {
      const at = (x: number) => (key === 'offset' ? [x, 0] : x);
      expect(parse({ [key]: at(lo - 0.01) }), `${key} below`).toBe(false);
      expect(parse({ [key]: at(hi + 0.01) }), `${key} above`).toBe(false);
    }
    expect(parse({ offset: [0, HAT_FIT_LIMITS.offset[1] + 1] }), 'offset y').toBe(false);
  });

  it("refuses anything that would rewrite the art's shape", () => {
    expect(parse({ outline: [[0, 0]] })).toBe(false);
    expect(parse({ brim: [0, 10, 20] })).toBe(false);
    expect(parse({ tilt: -30, canvas: [64, 80] })).toBe(false);
  });
});
