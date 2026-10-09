import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The join grant and the end-of-event unequip, executed as written against an in-process Postgres
 * that also carries the placement trigger. Both are money-adjacent (a hat is a scored slot), and
 * their correctness lives in the SQL (NOT EXISTS, the RETURNING of pre-update values), which a
 * mocked client cannot see.
 */

vi.mock('~/server/redis/caches', () => ({
  cosmeticCache: { refresh: vi.fn() },
  cosmeticEntityCaches: new Proxy({}, { get: () => ({ refresh: vi.fn() }) }),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));
vi.mock('~/server/integrations/discord', () => ({ discord: {} }));

const { eventEngine } = await import('~/server/events/index');
const { unequipEventCosmetics } = await import(
  '~/server/events/scoring/cosmetic-placement.service'
);

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261012120000_event_cosmetic_placement/migration.sql'
);
const db = { pg: null as unknown as PGlite };

// Run a Prisma tagged-template call as the parameterised statement Prisma would send.
function toQuery(strings: TemplateStringsArray, values: unknown[]) {
  return strings.reduce((sql, part, i) => sql + part + (i < values.length ? `$${i + 1}` : ''), '');
}

const HATS = { Yellow: 21, Blue: 22, Pink: 23, Green: 24 } as const;
const FRAME = 30;
const OTHER_EVENT_HAT = 31;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');
    CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'ContentDecoration');
    CREATE TABLE "Cosmetic" ("id" integer PRIMARY KEY, "name" text, "type" "CosmeticType" NOT NULL, "data" jsonb);
    CREATE TABLE "UserCosmetic" (
      "userId" integer NOT NULL, "cosmeticId" integer NOT NULL, "claimKey" text NOT NULL DEFAULT 'claimed',
      "obtainedAt" timestamp(3) NOT NULL DEFAULT now(), "equippedAt" timestamp(3), "data" jsonb,
      "equippedToId" integer, "equippedToType" "CosmeticEntity",
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Article" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));

  const run = async (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(toQuery(strings, values), values as unknown[]);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (s: TemplateStringsArray, ...v: unknown[]) =>
    (await run(s, ...v)).affectedRows ?? 0) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (s: TemplateStringsArray, ...v: unknown[]) =>
    (await run(s, ...v)).rows) as never);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    TRUNCATE "UserCosmetic", "Cosmetic", "Image", "Model", "Article", "EventCosmeticPlacement";
    INSERT INTO "Cosmetic" VALUES
      (${HATS.Yellow}, 'Basic Party Hat - Yellow', 'ContentDecoration', '{"event":"birthday2026","team":"Yellow"}'),
      (${HATS.Blue}, 'Basic Party Hat - Blue', 'ContentDecoration', '{"event":"birthday2026","team":"Blue"}'),
      (${HATS.Pink}, 'Basic Party Hat - Pink', 'ContentDecoration', '{"event":"birthday2026","team":"Pink"}'),
      (${HATS.Green}, 'Basic Party Hat - Green', 'ContentDecoration', '{"event":"birthday2026","team":"Green"}'),
      (${FRAME}, 'Some Frame', 'ContentDecoration', '{"type":"holiday-lights"}'),
      (${OTHER_EVENT_HAT}, 'Other Hat', 'ContentDecoration', '{"event":"another","team":"Yellow"}');
    INSERT INTO "Image" VALUES (1, 7), (2, 7), (3, 8);
    INSERT INTO "Model" VALUES (4, 7);
  `);
  redisMock.redis.hGet.mockImplementation(async (_key: string, name: string) => {
    const team = name.replace('Basic Party Hat - ', '') as keyof typeof HATS;
    return HATS[team]?.toString() ?? null;
  });
  redisMock.sysRedis.hGetAll.mockResolvedValue({ '7': 'Blue' });
});

async function hats(userId: number) {
  const res = await db.pg.query<{ cosmeticId: number; claimKey: string }>(
    `SELECT "cosmeticId", "claimKey" FROM "UserCosmetic" WHERE "userId" = $1 ORDER BY "cosmeticId", "claimKey"`,
    [userId]
  );
  return res.rows.map((r) => [r.cosmeticId, r.claimKey]);
}

describe('join grant', () => {
  it('grants one unequipped team hat, however many times it is called', async () => {
    const results = await Promise.all([
      eventEngine.join(BIRTHDAY_2026_EVENT, 7, BIRTHDAY_2026_STARTS_AT),
      eventEngine.join(BIRTHDAY_2026_EVENT, 7, BIRTHDAY_2026_STARTS_AT),
    ]);
    await eventEngine.join(BIRTHDAY_2026_EVENT, 7, BIRTHDAY_2026_STARTS_AT);

    expect(await hats(7)).toEqual([[HATS.Blue, 'claimed']]);
    expect(results.filter((r) => r.joined)).toHaveLength(1);
    const placed = await db.pg.query(`SELECT 1 FROM "EventCosmeticPlacement"`);
    expect(placed.rows).toHaveLength(0);
  });

  it('grants nothing more after a manual team reassignment', async () => {
    await eventEngine.join(BIRTHDAY_2026_EVENT, 7, BIRTHDAY_2026_STARTS_AT);
    redisMock.sysRedis.hGetAll.mockResolvedValue({ '7': 'Pink' });
    const again = await eventEngine.join(BIRTHDAY_2026_EVENT, 7, BIRTHDAY_2026_STARTS_AT);

    expect(again.joined).toBe(false);
    expect(await hats(7)).toEqual([[HATS.Blue, 'claimed']]);
  });

  it('is not blocked by a shop-bought hat (different claimKey)', async () => {
    await db.pg.exec(
      `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey") VALUES (7, ${HATS.Blue}, 'txn-1')`
    );
    const res = await eventEngine.join(BIRTHDAY_2026_EVENT, 7, BIRTHDAY_2026_STARTS_AT);

    expect(res.joined).toBe(true);
    expect(await hats(7)).toEqual([
      [HATS.Blue, 'claimed'],
      [HATS.Blue, 'txn-1'],
    ]);
  });
});

describe('end-of-event unequip', () => {
  it("clears only this event's placed cosmetics, reports where they were, and closes their intervals", async () => {
    await db.pg.exec(`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", "equippedToId", "equippedToType", "equippedAt") VALUES
        (7, ${HATS.Blue}, 'claimed', 1, 'Image', now()),
        (7, ${HATS.Blue}, 'txn-1', 4, 'Model', now()),
        (7, ${HATS.Blue}, 'txn-2', NULL, NULL, NULL),
        (7, ${FRAME}, 'claimed', 2, 'Image', now()),
        (8, ${OTHER_EVENT_HAT}, 'claimed', 3, 'Image', now());
    `);

    const entities = await unequipEventCosmetics(BIRTHDAY_2026_EVENT);

    expect(
      entities.map((e) => [e.entityType, e.entityId]).sort((a, b) => Number(a[1]) - Number(b[1]))
    ).toEqual([
      ['Image', 1],
      ['Model', 4],
    ]);
    const left = await db.pg.query<{ cosmeticId: number; equippedToId: number | null }>(
      `SELECT "cosmeticId", "equippedToId" FROM "UserCosmetic" WHERE "equippedToId" IS NOT NULL ORDER BY "cosmeticId"`
    );
    expect(left.rows.map((r) => r.cosmeticId)).toEqual([FRAME, OTHER_EVENT_HAT]);
    const open = await db.pg.query<{ event: string }>(
      `SELECT event FROM "EventCosmeticPlacement" WHERE "endedAt" IS NULL ORDER BY event`
    );
    expect(open.rows.map((r) => r.event)).toEqual(['another']);
  });
});
