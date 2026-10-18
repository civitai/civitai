import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A shop refund takes back what the purchase granted: a cosmetic, a pack's components, a held mystery
 * box, or an opened box's reward. Which rows go is the whole claim, so this runs against a real
 * Postgres with the mystery box migrations applied verbatim.
 */

const { dbHandle, bustUserCosmeticCaches, recordModActivity } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  bustUserCosmeticCaches: vi.fn(async () => undefined),
  recordModActivity: vi.fn(async () => undefined),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../cache', () => ({ bustUserCosmeticCaches }));
vi.mock('../mod-activity', () => ({ recordModActivity, recordModActivityBatch: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({ locals: {}, request: new Request('http://x') }),
}));

const { refundShopPurchase } = await import('../user-actions.service');

const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

// Stand-ins for the shop tables, cut to the columns a refund touches. The mystery box tables and
// both CHECKs come from the real migrations.
const SCHEMA = `
CREATE TABLE "Cosmetic" ("id" INTEGER PRIMARY KEY);
CREATE TABLE "CosmeticShopItem" (
  "id" INTEGER PRIMARY KEY,
  "cosmeticId" INTEGER,
  "title" TEXT NOT NULL DEFAULT 'listing',
  "listed" BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE "UserCosmeticShopPurchases" (
  "buzzTransactionId" TEXT PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "cosmeticId" INTEGER,
  "shopItemId" INTEGER NOT NULL REFERENCES "CosmeticShopItem"("id"),
  "refunded" BOOLEAN NOT NULL
);
CREATE TABLE "UserCosmeticShopPurchaseCosmetic" (
  "buzzTransactionId" TEXT NOT NULL,
  "cosmeticId" INTEGER NOT NULL,
  PRIMARY KEY ("buzzTransactionId", "cosmeticId")
);
CREATE TABLE "UserCosmetic" (
  "userId" INTEGER NOT NULL,
  "cosmeticId" INTEGER NOT NULL,
  "claimKey" TEXT NOT NULL DEFAULT 'claimed',
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);
`;

const BUYER = 5150;
const OTHER = 6160;
const MOD = 1;
const HAT = 500; // a box reward
const OTHER_HAT = 501;
const BOX_LISTING = 10;
const PACK_LISTING = 11;
const SHELF_LISTING = 12;

let db: PGlite;
let statements: { sql: string; params: unknown[] }[];
/** Runs once, straight after the service's first statement (its read of the purchase). */
let afterFirstStatement: (() => Promise<unknown>) | null;

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.exec(migration('20261105120000_mystery_box_items'));
  await db.exec(migration('20261107120000_mystery_box_listing_unlisted_and_refunds'));
  await db.exec(`
    INSERT INTO "Cosmetic" ("id") VALUES (${HAT}), (${OTHER_HAT}), (600), (601), (700);
    INSERT INTO "ItemDefinition" ("id", "type", "name", "status") VALUES (1, 'box', 'Box', 'published');
    INSERT INTO "ItemDefinition" ("id", "type", "name", "cosmeticId") VALUES
      (2, 'cosmetic', 'Hat', ${HAT}), (3, 'cosmetic', 'Other hat', ${OTHER_HAT});
    INSERT INTO "CosmeticShopItem" ("id", "cosmeticId", "itemDefinitionId", "listed") VALUES
      (${BOX_LISTING}, NULL, 1, false), (${PACK_LISTING}, NULL, NULL, true), (${SHELF_LISTING}, 700, NULL, true);
  `);

  statements = [];
  afterFirstStatement = null;
  const recording = {
    query: async (sql: string, params: unknown[]) => {
      statements.push({ sql, params });
      const result = await db.query(sql, params);
      const hook = afterFirstStatement;
      afterFirstStatement = null;
      await hook?.();
      return result;
    },
  } as unknown as PGlite;
  dbHandle.current = new Kysely({ dialect: pgliteDialect(recording) });
  recordModActivity.mockClear();
  bustUserCosmeticCaches.mockClear();
});

afterEach(async () => {
  await db.close();
  dbHandle.current = null;
});

const purchase = (tx: string, shopItemId: number, cosmeticId: number | null, userId = BUYER) =>
  db.query(
    `INSERT INTO "UserCosmeticShopPurchases" ("buzzTransactionId", "userId", "cosmeticId", "shopItemId", "refunded")
     VALUES ($1, $2, $3, $4, false)`,
    [tx, userId, cosmeticId, shopItemId]
  );
const holdBox = (tx: string, userId = BUYER) =>
  db.query(
    `INSERT INTO "Item" ("itemDefinitionId", "holderType", "holderId", "sourceKey") VALUES (1, 'user', $1, $2)`,
    [userId, tx]
  );
const openedBox = async (
  tx: string,
  boxItemId: number,
  rewardDefinitionId: number,
  cosmeticId: number
) => {
  await db.query(
    `INSERT INTO "BoxOpening" ("boxItemId", "boxDefinitionId", "boxVersion", "userId", "boxSourceKey",
       "tierId", "contentId", "rewardDefinitionId", "rewardType", "tierWeight", "eligibleWeight",
       "tierRoll", "tierPoolSize", "itemRoll", "rewardStatus")
     VALUES ($1, 1, 1, $2, $3, 1, 1, $4, 'cosmetic', 1, 1, 0, 1, 0, 'granted')`,
    [boxItemId, BUYER, tx, rewardDefinitionId]
  );
  await grant(cosmeticId, `box-open-${boxItemId}`);
};
const grant = (cosmeticId: number, claimKey: string, userId = BUYER) =>
  db.query(`INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey") VALUES ($1, $2, $3)`, [
    userId,
    cosmeticId,
    claimKey,
  ]);

const refund = (buzzTransactionId: string, userId = BUYER) =>
  refundShopPurchase({ userId, buzzTransactionId, moderatorId: MOD });

const holdings = async () =>
  (
    await db.query<{ userId: number; cosmeticId: number; claimKey: string }>(
      `SELECT "userId", "cosmeticId", "claimKey" FROM "UserCosmetic" ORDER BY 1, 2, 3`
    )
  ).rows;
const heldBoxes = async () =>
  (await db.query<{ sourceKey: string }>(`SELECT "sourceKey" FROM "Item" ORDER BY 1`)).rows.map(
    (r) => r.sourceKey
  );
const isRefunded = async (tx: string) =>
  (
    await db.query<{ refunded: boolean }>(
      `SELECT "refunded" FROM "UserCosmeticShopPurchases" WHERE "buzzTransactionId" = $1`,
      [tx]
    )
  ).rows[0].refunded;
const openingStatus = async (boxItemId: number) =>
  (
    await db.query<{ rewardStatus: string }>(
      `SELECT "rewardStatus" FROM "BoxOpening" WHERE "boxItemId" = $1`,
      [boxItemId]
    )
  ).rows[0].rewardStatus;

describe('refundShopPurchase: a mystery box', () => {
  it('takes back a held box, and only that box', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await purchase('box-b', BOX_LISTING, null);
    await holdBox('box-a');
    await holdBox('box-b');

    await expect(refund('box-a')).resolves.toEqual({ ok: true });

    expect(await heldBoxes()).toEqual(['box-b']);
    expect(await isRefunded('box-a')).toBe(true);
    expect(await isRefunded('box-b')).toBe(false);
    expect(bustUserCosmeticCaches).toHaveBeenCalledWith(BUYER);
    expect(recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: MOD, entityId: BUYER, activity: 'shopRefund' })
    );
  });

  it('takes back an opened box’s reward and marks the opening refunded, keeping it', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await purchase('box-b', BOX_LISTING, null);
    await openedBox('box-a', 77, 2, HAT);
    await openedBox('box-b', 78, 3, OTHER_HAT);

    await expect(refund('box-a')).resolves.toEqual({ ok: true });

    expect(await holdings()).toEqual([
      { userId: BUYER, cosmeticId: OTHER_HAT, claimKey: 'box-open-78' },
    ]);
    expect(await openingStatus(77)).toBe('refunded');
    expect(await openingStatus(78)).toBe('granted');
    expect(await isRefunded('box-a')).toBe(true);
  });

  it('refuses a box purchase with neither a held box nor an opening, and flags nothing', async () => {
    await purchase('box-a', BOX_LISTING, null);

    await expect(refund('box-a')).resolves.toEqual({
      ok: false,
      error: 'Neither the box nor what it gave is on this account.',
    });
    expect(await isRefunded('box-a')).toBe(false);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('does not reach another user’s box under the same key', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await holdBox('box-a', OTHER);

    await expect(refund('box-a')).resolves.toMatchObject({ ok: false });
    expect(await heldBoxes()).toEqual(['box-a']);
  });

  it('refunds once when another refund lands between its read and its transaction', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await holdBox('box-a');
    afterFirstStatement = () =>
      db.query(
        `UPDATE "UserCosmeticShopPurchases" SET "refunded" = true WHERE "buzzTransactionId" = 'box-a'`
      );

    await expect(refund('box-a')).resolves.toEqual({
      ok: false,
      error: 'That purchase is already refunded.',
    });
    expect(await heldBoxes()).toEqual(['box-a']);
  });

  it('takes the item holder lock for the buyer before its first write', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await holdBox('box-a');

    await refund('box-a');

    const begin = statements.findIndex((s) => s.sql === 'begin');
    expect(begin).toBeGreaterThan(-1);
    expect(statements[begin + 1]).toEqual({
      sql: 'SELECT pg_advisory_xact_lock($1::int, $2::int)',
      // The literal, not the shared constant: the main app locks under this number too.
      params: [1229455361, BUYER],
    });
  });
});

describe('refundShopPurchase: shelf purchases', () => {
  it('takes back a pack’s components under its key, and nothing the buyer held before', async () => {
    await purchase('pack-a', PACK_LISTING, null);
    await db.exec(
      `INSERT INTO "UserCosmeticShopPurchaseCosmetic" VALUES ('pack-a', 600), ('pack-a', 601)`
    );
    await grant(600, 'pack-a');
    await grant(601, 'pack-a');
    await grant(600, 'claimed');
    await grant(601, 'pack-b');

    await expect(refund('pack-a')).resolves.toEqual({ ok: true });

    expect(await holdings()).toEqual([
      { userId: BUYER, cosmeticId: 600, claimKey: 'claimed' },
      { userId: BUYER, cosmeticId: 601, claimKey: 'pack-b' },
    ]);
  });

  it('takes back a single cosmetic', async () => {
    await purchase('shelf-a', SHELF_LISTING, 700);
    await grant(700, 'shelf-a');
    await grant(700, 'claimed');

    await expect(refund('shelf-a')).resolves.toEqual({ ok: true });

    expect(await holdings()).toEqual([{ userId: BUYER, cosmeticId: 700, claimKey: 'claimed' }]);
  });

  it('refuses a second refund, and another user’s purchase', async () => {
    await purchase('shelf-a', SHELF_LISTING, 700);
    await grant(700, 'shelf-a');

    await expect(refund('shelf-a', OTHER)).resolves.toEqual({
      ok: false,
      error: 'That purchase does not belong to this user.',
    });
    await expect(refund('shelf-a')).resolves.toEqual({ ok: true });
    await expect(refund('shelf-a')).resolves.toEqual({
      ok: false,
      error: 'That purchase is already refunded.',
    });
  });
});

describe('box listing CHECK', () => {
  const list = (id: number) =>
    db.query(`UPDATE "CosmeticShopItem" SET "listed" = true WHERE "id" = $1`, [id]);

  it('refuses a listed box listing, on insert and on update', async () => {
    await expect(list(BOX_LISTING)).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.query(`INSERT INTO "CosmeticShopItem" ("id", "itemDefinitionId") VALUES (20, 1)`)
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('still lists a pack (control)', async () => {
    await expect(list(PACK_LISTING)).resolves.toMatchObject({ affectedRows: 1 });
  });
});
