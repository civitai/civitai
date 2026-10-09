import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';

// The placement of an event decoration is one hand-written UPDATE that also enforces the move
// cooldown. The unit test pins its shape; this runs the statement the service actually builds
// against real Postgres, because a shape cannot show that the SQL is valid or that it records
// placedAt on a row whose `data` is NULL.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const db = dbMock.dbWrite;

db.$executeRaw.mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
  return affectedRows ?? 0;
}) as never);

vi.mock('~/server/redis/caches', () => {
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
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  articlesSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));

const { equipCosmeticToEntity } = await import('~/server/services/cosmetic.service');

const OWNER = 7;
const HAT_ID = 1;
const DURING = new Date(BIRTHDAY_2026_STARTS_AT.getTime() + 24 * 60 * 60 * 1000);
const minutesAgo = (n: number) => new Date(DURING.getTime() - n * 60 * 1000).toISOString();
const HAT = { type: 'hat', event: BIRTHDAY_2026_EVENT, url: 'hat.png' };

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');
    CREATE TABLE "UserCosmetic" (
      "userId" int NOT NULL,
      "cosmeticId" int NOT NULL,
      "claimKey" text NOT NULL,
      "equippedToId" int,
      "equippedToType" "CosmeticEntity",
      "equippedAt" timestamp(3),
      data jsonb,
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
  `);
});

async function seed(claimKey: string, data: unknown) {
  await holder.db.query(
    `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", data) VALUES ($1, $2, $3, $4)`,
    [OWNER, HAT_ID, claimKey, data === null ? null : JSON.stringify(data)]
  );
}

async function row(claimKey: string) {
  const { rows } = await holder.db.query<{
    equippedToId: number | null;
    equippedToType: string | null;
    data: Record<string, unknown> | null;
  }>(`SELECT "equippedToId", "equippedToType", data FROM "UserCosmetic" WHERE "claimKey" = $1`, [
    claimKey,
  ]);
  return rows[0];
}

/** `staleData` is what the service's own read sees, which a concurrent equip can make stale. */
function equip(claimKey: string, imageId: number, staleData: unknown = null) {
  db.userCosmetic.findFirst.mockResolvedValueOnce({
    obtainedAt: new Date(),
    equippedToId: null,
    equippedToType: null,
    forId: null,
    forType: null,
    data: staleData,
    cosmetic: { type: 'ContentDecoration', data: HAT },
  });
  return equipCosmeticToEntity({
    userId: OWNER,
    cosmeticId: HAT_ID,
    claimKey,
    equippedToId: imageId,
    equippedToType: 'Image',
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DURING);
  await holder.db.exec(`DELETE FROM "UserCosmetic"`);
  db.image.findUnique.mockResolvedValue({ userId: OWNER });
  db.userCosmetic.findMany.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe('placing an event decoration in Postgres', () => {
  it.each([
    ['NULL', null],
    ['an empty object', {}],
    ['JSON null', 'null-json'],
  ])('records placedAt on a hat whose data is %s', async (_, data) => {
    if (data === 'null-json')
      await holder.db.query(
        `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", data) VALUES ($1, $2, 'k', 'null'::jsonb)`,
        [OWNER, HAT_ID]
      );
    else await seed('k', data);

    await equip('k', 501);

    expect(await row('k')).toEqual({
      equippedToId: 501,
      equippedToType: 'Image',
      data: { placedAt: DURING.toISOString() },
    });
  });

  it('keeps the rest of the data when it records placedAt', async () => {
    await seed('k', { lights: 3, placedAt: minutesAgo(30) });
    await equip('k', 501, { lights: 3, placedAt: minutesAgo(30) });
    expect((await row('k')).data).toEqual({ lights: 3, placedAt: DURING.toISOString() });
  });

  it('refuses when the row was placed within the cooldown, even if the read said otherwise', async () => {
    await seed('k', { placedAt: minutesAgo(5) });

    await expect(equip('k', 502, { placedAt: minutesAgo(30) })).rejects.toThrow(/moved recently/);
    expect(await row('k')).toEqual({
      equippedToId: null,
      equippedToType: null,
      data: { placedAt: minutesAgo(5) },
    });
  });

  it('lets exactly one of two simultaneous moves of the same hat through', async () => {
    await seed('k', null);

    const results = await Promise.allSettled([equip('k', 501), equip('k', 502)]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await row('k')).data).toEqual({ placedAt: DURING.toISOString() });
  });
});
