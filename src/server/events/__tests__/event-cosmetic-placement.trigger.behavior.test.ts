import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * What the `event_cosmetic_placement_log` trigger does to real rows. Executed on an in-process
 * Postgres, running the committed migration file unmodified, because the property under test is the
 * interval bookkeeping and the WHEN clauses, neither of which a string assertion on SQL can see.
 *
 * The statements below mirror the real writers: `equipCosmeticToEntity` (unequip whatever is on the
 * target, then move this instance), `unequipCosmetic`, revoke (DELETE), bulk grants (INSERT with no
 * placement) and the end-of-event cleanup (UPDATE ... SET "equippedToId" = NULL).
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261012120000_event_cosmetic_placement/migration.sql'
);

const db = { pg: null as unknown as PGlite };

const OWNER = 101;
const OTHER = 202;
const HAT = 1; // event cosmetic, team Yellow
const HAT_BLUE = 2; // event cosmetic, team Blue
const FRAME = 3; // content decoration with no event
const BADGE = 4;

type Placement = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  event: string;
  team: string;
  entityType: string;
  entityId: number;
  entityOwnerId: number | null;
  open: boolean;
};

async function placements(): Promise<Placement[]> {
  const res = await db.pg.query<Placement>(`
    SELECT "userId", "cosmeticId", "claimKey", event, team, "entityType"::text AS "entityType",
           "entityId", "entityOwnerId", ("endedAt" IS NULL) AS open
    FROM "EventCosmeticPlacement" ORDER BY id
  `);
  return res.rows;
}

async function grant(userId: number, cosmeticId: number, claimKey = 'claimed') {
  await db.pg.query(
    `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey") VALUES ($1, $2, $3)`,
    [userId, cosmeticId, claimKey]
  );
}

// The writes equipCosmeticToEntity (src/server/services/cosmetic.service.ts) issues, in its order:
// first move this instance onto the target (also stamping data.placedAt), then clear whatever else of
// the same kind (event decoration or not) the user had on that target. Keep this in step with it.
async function equip(
  userId: number,
  cosmeticId: number,
  claimKey: string,
  type: 'Image' | 'Model' | 'Article' | 'Post',
  id: number
) {
  await db.pg.query(
    `UPDATE "UserCosmetic"
     SET "equippedToId" = $4, "equippedToType" = $5::"CosmeticEntity", "equippedAt" = now(),
         "data" = coalesce("data", '{}'::jsonb) || jsonb_build_object('placedAt', now()::text)
     WHERE "userId" = $1 AND "cosmeticId" = $2 AND "claimKey" = $3`,
    [userId, cosmeticId, claimKey, id, type]
  );
  await db.pg.query(
    `UPDATE "UserCosmetic" uc
     SET "equippedToId" = NULL, "equippedToType" = NULL, "equippedAt" = NULL
     FROM "Cosmetic" c
     WHERE c.id = uc."cosmeticId"
       AND uc."userId" = $1 AND uc."equippedToId" = $4 AND uc."equippedToType" = $5::"CosmeticEntity"
       AND NOT (uc."cosmeticId" = $2 AND uc."claimKey" = $3)
       AND (c.data ? 'event') = (SELECT data ? 'event' FROM "Cosmetic" WHERE id = $2)`,
    [userId, cosmeticId, claimKey, id, type]
  );
}

// Function stats are flushed to the shared view asynchronously; force the flush and drop the
// cached snapshot so the read reflects every statement already run.
async function functionCalls(): Promise<number> {
  await db.pg.exec(`SELECT pg_stat_force_next_flush()`);
  await db.pg.exec(`SELECT pg_stat_clear_snapshot()`);
  const res = await db.pg.query<{ calls: number }>(
    `SELECT coalesce(sum(calls), 0)::int AS calls FROM pg_stat_user_functions
     WHERE funcname = 'event_cosmetic_placement_log'`
  );
  return res.rows[0].calls;
}

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');
    CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration');
    CREATE TABLE "Cosmetic" ("id" integer PRIMARY KEY, "type" "CosmeticType" NOT NULL, "data" jsonb);
    CREATE TABLE "UserCosmetic" (
      "userId" integer NOT NULL, "cosmeticId" integer NOT NULL, "claimKey" text NOT NULL DEFAULT 'claimed',
      "obtainedAt" timestamp(3) NOT NULL DEFAULT now(), "equippedAt" timestamp(3), "data" jsonb,
      "equippedToId" integer, "equippedToType" "CosmeticEntity", "forId" integer,
      "forType" "CosmeticEntity", "remaining" integer,
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Article" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
  await db.pg.exec(`SET track_functions = 'all'`);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    TRUNCATE "UserCosmetic", "Cosmetic", "Image", "Model", "Article", "EventCosmeticPlacement";
    INSERT INTO "Cosmetic" VALUES
      (${HAT}, 'ContentDecoration', '{"type":"hat","event":"birthday2026","team":"Yellow"}'),
      (${HAT_BLUE}, 'ContentDecoration', '{"type":"hat","event":"birthday2026","team":"Blue"}'),
      (${FRAME}, 'ContentDecoration', '{"type":"holiday-lights"}'),
      (${BADGE}, 'Badge', '{"event":"birthday2026","team":"Yellow"}');
    INSERT INTO "Image" VALUES (10, ${OWNER}), (11, ${OWNER}), (12, ${OTHER});
    INSERT INTO "Model" VALUES (20, ${OWNER}), (10, ${OWNER});
    INSERT INTO "Article" VALUES (30, ${OWNER});
  `);
});

describe('event_cosmetic_placement_log trigger', () => {
  it('opens one interval with event, team and content owner when an event cosmetic is placed', async () => {
    await grant(OWNER, HAT);
    await equip(OWNER, HAT, 'claimed', 'Image', 10);

    expect(await placements()).toEqual([
      {
        userId: OWNER,
        cosmeticId: HAT,
        claimKey: 'claimed',
        event: 'birthday2026',
        team: 'Yellow',
        entityType: 'Image',
        entityId: 10,
        entityOwnerId: OWNER,
        open: true,
      },
    ]);
  });

  it('closes the old interval and opens a new one when the cosmetic moves', async () => {
    await grant(OWNER, HAT);
    await equip(OWNER, HAT, 'claimed', 'Image', 10);
    await equip(OWNER, HAT, 'claimed', 'Model', 20);

    const rows = await placements();
    expect(rows.map((r) => [r.entityType, r.entityId, r.open])).toEqual([
      ['Image', 10, false],
      ['Model', 20, true],
    ]);
  });

  it('closes the displaced cosmetic when another is equipped onto the same content', async () => {
    await grant(OWNER, HAT);
    await grant(OWNER, HAT_BLUE);
    await equip(OWNER, HAT, 'claimed', 'Article', 30);
    await equip(OWNER, HAT_BLUE, 'claimed', 'Article', 30);

    const rows = await placements();
    expect(rows.map((r) => [r.cosmeticId, r.team, r.open])).toEqual([
      [HAT, 'Yellow', false],
      [HAT_BLUE, 'Blue', true],
    ]);
  });

  it('tracks two copies of one design as separate instances', async () => {
    await grant(OWNER, HAT, 'txn-1');
    await grant(OWNER, HAT, 'txn-2');
    await equip(OWNER, HAT, 'txn-1', 'Image', 10);
    await equip(OWNER, HAT, 'txn-2', 'Image', 11);

    const rows = await placements();
    expect(rows.map((r) => [r.claimKey, r.entityId, r.open])).toEqual([
      ['txn-1', 10, true],
      ['txn-2', 11, true],
    ]);
  });

  it('closes the interval on unequip, on revoke (DELETE) and on cleanup-style bulk unequip', async () => {
    await grant(OWNER, HAT, 'a');
    await grant(OWNER, HAT, 'b');
    await grant(OWNER, HAT, 'c');
    await equip(OWNER, HAT, 'a', 'Image', 10);
    await equip(OWNER, HAT, 'b', 'Image', 11);
    await equip(OWNER, HAT, 'c', 'Model', 20);

    await db.pg.query(
      `UPDATE "UserCosmetic" SET "equippedToId" = NULL, "equippedToType" = NULL, "equippedAt" = NULL
       WHERE "userId" = $1 AND "cosmeticId" = $2 AND "claimKey" = 'a'`,
      [OWNER, HAT]
    );
    await db.pg.query(`DELETE FROM "UserCosmetic" WHERE "claimKey" = 'b'`);
    await db.pg.query(
      `UPDATE "UserCosmetic" SET "equippedToId" = NULL, "equippedToType" = NULL, "equippedAt" = NULL
       WHERE "cosmeticId" IN (${HAT})`
    );

    const rows = await placements();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.open)).toEqual([]);
  });

  it('records the real content owner when a cosmetic sits on someone else’s content', async () => {
    await grant(OWNER, HAT);
    await equip(OWNER, HAT, 'claimed', 'Image', 12);

    expect((await placements())[0].entityOwnerId).toBe(OTHER);
  });

  it('ignores content decorations without event + team, and non-decoration cosmetics', async () => {
    await grant(OWNER, FRAME);
    await grant(OWNER, BADGE);
    await equip(OWNER, FRAME, 'claimed', 'Image', 10);
    await equip(OWNER, BADGE, 'claimed', 'Image', 11);

    expect(await placements()).toEqual([]);
  });

  it('keeps one open interval when the same cosmetic is re-equipped onto the same content', async () => {
    await grant(OWNER, HAT);
    await equip(OWNER, HAT, 'claimed', 'Image', 10);
    await equip(OWNER, HAT, 'claimed', 'Image', 10);

    const rows = await placements();
    expect(rows.map((r) => [r.entityType, r.entityId, r.open])).toEqual([['Image', 10, true]]);
  });

  it('closes and reopens when only the entity TYPE changes (same id)', async () => {
    await grant(OWNER, HAT);
    await equip(OWNER, HAT, 'claimed', 'Image', 10);
    await equip(OWNER, HAT, 'claimed', 'Model', 10);

    const rows = await placements();
    expect(rows.map((r) => [r.entityType, r.entityId, r.open])).toEqual([
      ['Image', 10, false],
      ['Model', 10, true],
    ]);
  });

  it('records no owner for an entity type it cannot look up, so scoring never counts it', async () => {
    await grant(OWNER, HAT);
    await equip(OWNER, HAT, 'claimed', 'Post', 99);

    expect((await placements()).map((r) => [r.entityType, r.entityOwnerId])).toEqual([
      ['Post', null],
    ]);
  });

  it('leaves no lock_timeout behind on the session that applied the migration', async () => {
    // SET LOCAL ends with its DO block; a plain SET would leave 2s on a pooled connection.
    const res = await db.pg.query<{ lock_timeout: string }>('SHOW lock_timeout');
    expect(res.rows[0].lock_timeout).toBe('0');
  });

  it('opens no second interval when only equippedAt changes', async () => {
    await grant(OWNER, HAT);
    await equip(OWNER, HAT, 'claimed', 'Image', 10);
    await db.pg.query(`UPDATE "UserCosmetic" SET "equippedAt" = now() WHERE "cosmeticId" = $1`, [
      HAT,
    ]);

    const rows = await placements();
    expect(rows.map((r) => [r.entityId, r.open])).toEqual([[10, true]]);
  });

  it('closes a stale open interval instead of failing the equip on the unique index', async () => {
    await grant(OWNER, HAT);
    await db.pg.query(
      `INSERT INTO "EventCosmeticPlacement" (event, "userId", "cosmeticId", "claimKey", team, "entityType", "entityId")
       VALUES ('birthday2026', $1, $2, 'claimed', 'Yellow', 'Image', 11)`,
      [OWNER, HAT]
    );
    await equip(OWNER, HAT, 'claimed', 'Image', 10);

    const rows = await placements();
    expect(rows.map((r) => [r.entityId, r.open])).toEqual([
      [11, false],
      [10, true],
    ]);
  });

  it('a bulk grant of unplaced rows never calls the trigger function', async () => {
    // Positive control first: the counter does move when the function runs, so a zero below is a
    // measurement and not a counter that cannot count.
    await grant(OWNER, HAT);
    const before = await functionCalls();
    await equip(OWNER, HAT, 'claimed', 'Image', 10);
    expect(await functionCalls()).toBeGreaterThan(before);

    const beforeBulk = await functionCalls();
    await db.pg.exec(`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")
      SELECT g, ${BADGE}, 'claimed' FROM generate_series(1000, 1999) g;
      UPDATE "UserCosmetic" SET "equippedAt" = now() WHERE "cosmeticId" = ${BADGE};
    `);
    expect(await functionCalls()).toBe(beforeBulk);
  });
});
