import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Which hat an avatar shows is one hand-written statement: the player's pick if they still own it,
// else the roster card's lead hat (placed, then dearest, then newest), else nothing. This runs it
// against real Postgres, because only that can show the ORDER BY and the settings read are right.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/redis/caches', () => ({ cosmeticCache: { fetch: vi.fn() } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: () => ({ fetch: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('~/server/services/creator-shop-withheld', () => ({
  getWithheldCosmeticIds: vi.fn(async () => new Set()),
}));

const { resolveShowcaseHatIds, SHOWCASE_SETTING } = await import('~/server/events/showcase-hat');

const EVENT = 'birthday2026';
const pg = new PGlite();
const db = {
  $queryRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).rows;
  }) as never,
};

// Hats 1-4 are this event's; 9 is another event's, which must never be picked.
const CAP = 1; // free join hat, no price
const CHEAP = 2;
const DEAR = 3;
const DEAR_TOO = 4;
const OTHER_EVENT = 9;

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, settings jsonb);
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "CosmeticShopItem" ("cosmeticId" int, "unitAmount" int);
    CREATE TABLE "UserCosmetic" (
      "userId" int, "cosmeticId" int, "claimKey" text, "equippedToId" int, "obtainedAt" timestamp(3),
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    INSERT INTO "Cosmetic" VALUES
      (1, 'ContentDecoration', '{"event":"${EVENT}"}'),
      (2, 'ContentDecoration', '{"event":"${EVENT}"}'),
      (3, 'ContentDecoration', '{"event":"${EVENT}"}'),
      (4, 'ContentDecoration', '{"event":"${EVENT}"}'),
      (9, 'ContentDecoration', '{"event":"another"}');
    INSERT INTO "CosmeticShopItem" VALUES (2, 100), (3, 500), (4, 500), (9, 9999);
  `);
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM "User"; DELETE FROM "UserCosmetic";`);
});

async function user(id: number, pick?: number | null) {
  const settings = pick === undefined ? {} : { [SHOWCASE_SETTING]: { [EVENT]: pick } };
  await pg.query(`INSERT INTO "User" VALUES ($1, $2)`, [id, JSON.stringify(settings)]);
}
async function hat(
  userId: number,
  cosmeticId: number,
  opts: { placed?: boolean; day?: number } = {}
) {
  await pg.query(`INSERT INTO "UserCosmetic" VALUES ($1, $2, $3, $4, $5)`, [
    userId,
    cosmeticId,
    `k${cosmeticId}`,
    opts.placed ? 500 + cosmeticId : null,
    new Date(Date.UTC(2026, 10, opts.day ?? 1)).toISOString(),
  ]);
}
const resolve = async (...ids: number[]) =>
  Object.fromEntries(await resolveShowcaseHatIds(EVENT, ids, db));

describe('resolveShowcaseHatIds', () => {
  it("shows the player's pick over every default, placed or not", async () => {
    await user(1, CHEAP);
    await hat(1, CHEAP);
    await hat(1, DEAR, { placed: true });
    expect(await resolve(1)).toEqual({ 1: CHEAP });
  });

  it('ignores a pick the player does not own, and falls back to the default', async () => {
    await user(1, DEAR);
    await hat(1, CAP, { placed: true });
    expect(await resolve(1)).toEqual({ 1: CAP });
  });

  it('never shows a hat from another event, even a picked one', async () => {
    await user(1, OTHER_EVENT);
    await hat(1, OTHER_EVENT, { placed: true });
    await hat(1, CAP);
    expect(await resolve(1)).toEqual({ 1: CAP });
  });

  it('defaults to a placed hat over a dearer unplaced one', async () => {
    await user(1);
    await hat(1, CAP, { placed: true });
    await hat(1, DEAR);
    expect(await resolve(1)).toEqual({ 1: CAP });
  });

  it('among placed hats, defaults to the dearest, then the newest on a tie', async () => {
    await user(1);
    await hat(1, CHEAP, { placed: true, day: 9 });
    await hat(1, DEAR, { placed: true, day: 2 });
    await hat(1, DEAR_TOO, { placed: true, day: 5 });
    expect(await resolve(1)).toEqual({ 1: DEAR_TOO });
  });

  it('with nothing placed, defaults to the top owned hat, so every joiner shows one', async () => {
    await user(1, null);
    await hat(1, CAP, { day: 9 });
    await hat(1, CHEAP, { day: 2 });
    expect(await resolve(1)).toEqual({ 1: CHEAP });
  });

  it('gives no entry to a user without hats, and resolves a batch in one call', async () => {
    await user(1);
    await user(2, CAP);
    await user(3);
    await hat(2, CAP);
    await hat(3, DEAR, { placed: true });
    expect(await resolve(1, 2, 3)).toEqual({ 2: CAP, 3: DEAR });
  });
});
