import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A shop refund takes back what the purchase granted: a cosmetic, a pack's components, a held mystery
 * box, or an opened box's reward. Which rows go is the whole claim, so this runs against a real
 * Postgres with the mystery box migrations applied verbatim.
 */

const { dbHandle, bustUserCosmeticCaches, recordModActivity, logAxiomError } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  bustUserCosmeticCaches: vi.fn(async () => undefined),
  recordModActivity: vi.fn(async () => undefined),
  logAxiomError: vi.fn(async () => undefined),
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
vi.mock('../axiom', () => ({ logAxiomError }));
vi.mock('$env/dynamic/private', () => ({ env: { CIVITAI_APP_URL: 'https://main.test' } }));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: new Request('http://x', { headers: { cookie: 'civ-token=the-moderator' } }),
  }),
}));

const { grantCosmetic, refundShopPurchase, removeCosmetic, takeBackGrantedBox } = await import(
  '../user-actions.service'
);
const { BoxGrantRefused, grantMysteryBoxes } = await import('../mystery-box-grant.service');
const { modGrantSourceKey } = await import('@civitai/shared/mystery-box');
const { grantCosmeticsToUsers } = await import('../cosmetics.service');
const { ITEM_HOLDER_BUSY_MESSAGE } = await import('../item-holder-lock');
const { ITEM_HOLDER_LOCK_TIMEOUT } = await import('@civitai/shared/item-holder-lock');

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
  "obtainedAt" TIMESTAMP(3),
  "equippedToId" INTEGER,
  "equippedToType" TEXT,
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY);
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
const LOCK_TIMEOUT = {
  sql: "SELECT set_config('lock_timeout', $1, true)",
  params: [ITEM_HOLDER_LOCK_TIMEOUT],
};
/** Which acquired connection ran each statement, by index into `statements`. */
let statementConnections: number[];
/** Runs once, straight after the service's first statement (its read of the purchase). */
let afterFirstStatement: (() => Promise<unknown>) | null;
/**
 * Users whose item holder lock fails, mapped to the SQLSTATE it fails with (55P03 is a lock timeout).
 */
let lockFails: Map<number, string>;
/** Calls the service made to the main app, and how the main app answers them. */
let mainApp: { url: string; body: unknown; afterCommit: boolean }[];
let mainAppAnswers: () => Response;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(migration('20261105120000_mystery_box_items'));
  await db.exec(migration('20261107120000_mystery_box_listing_unlisted_and_refunds'));
  await db.exec(migration('20261108120000_creator_mystery_packs'));
  await db.exec(`
    INSERT INTO "Cosmetic" ("id") VALUES (${HAT}), (${OTHER_HAT}), (600), (601), (700);
    INSERT INTO "ItemDefinition" ("id", "type", "name", "status") VALUES
      (1, 'box', 'Box', 'published'), (4, 'box', 'Another box', 'published');
    INSERT INTO "ItemDefinition" ("id", "type", "name", "cosmeticId") VALUES
      (2, 'cosmetic', 'Hat', ${HAT}), (3, 'cosmetic', 'Other hat', ${OTHER_HAT});
    INSERT INTO "CosmeticShopItem" ("id", "cosmeticId", "itemDefinitionId", "listed") VALUES
      (${BOX_LISTING}, NULL, 1, false), (${PACK_LISTING}, NULL, NULL, true), (${SHELF_LISTING}, 700, NULL, true);
  `);

  statements = [];
  statementConnections = [];
  afterFirstStatement = null;
  lockFails = new Map();
  const recording = {
    query: async (sql: string, params: unknown[]) => {
      statements.push({ sql, params });
      statementConnections.push(activeConnection);
      // Raised by Postgres inside the transaction, so it aborts it as a real failure would.
      const fails = sql.includes('pg_advisory_xact_lock') && lockFails.get(params[1] as number);
      if (fails)
        await db.query(
          `DO $$ BEGIN RAISE EXCEPTION 'lock failed' USING ERRCODE = '${fails}'; END $$`
        );
      const result = await db.query(sql, params);
      const hook = afterFirstStatement;
      afterFirstStatement = null;
      await hook?.();
      return result;
    },
  } as unknown as PGlite;
  let activeConnection = 0;
  dbHandle.current = new Kysely({
    dialect: pgliteDialect(recording, { onQuery: (conn) => (activeConnection = conn) }),
  });
  recordModActivity.mockClear();
  bustUserCosmeticCaches.mockClear();
  logAxiomError.mockClear();

  mainApp = [];
  mainAppAnswers = () => new Response(JSON.stringify({ refreshed: 1 }), { status: 200 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    mainApp.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      // The main app reads on its own connection: called before the commit, it re-derives the hat
      // as still held.
      afterCommit: statements.at(-1)?.sql === 'commit',
    });
    return mainAppAnswers();
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
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
const grant = (
  cosmeticId: number,
  claimKey: string,
  userId = BUYER,
  equippedTo?: { id: number; type: string }
) =>
  db.query(
    `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", "equippedToId", "equippedToType")
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, cosmeticId, claimKey, equippedTo?.id ?? null, equippedTo?.type ?? null]
  );
const equip = (cosmeticId: number, claimKey: string, entity: { id: number; type: string }) =>
  db.query(
    `UPDATE "UserCosmetic" SET "equippedToId" = $1, "equippedToType" = $2
     WHERE "userId" = $3 AND "cosmeticId" = $4 AND "claimKey" = $5`,
    [entity.id, entity.type, BUYER, cosmeticId, claimKey]
  );
const IMAGE = { id: 9001, type: 'Image' };
const REFRESH_URL = 'https://main.test/api/mod/cosmetic/holdings-removed';

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
    // The same hat held another way stays theirs.
    await grant(HAT, 'claimed');
    await grant(HAT, 'box-open-99');

    await expect(refund('box-a')).resolves.toEqual({ ok: true });

    expect(await holdings()).toEqual([
      { userId: BUYER, cosmeticId: HAT, claimKey: 'box-open-99' },
      { userId: BUYER, cosmeticId: HAT, claimKey: 'claimed' },
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

  it('touches only the box this listing sells, under the same key', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await db.query(
      `INSERT INTO "Item" ("itemDefinitionId", "holderType", "holderId", "sourceKey") VALUES (4, 'user', $1, 'box-a')`,
      [BUYER]
    );
    await db.query(
      `INSERT INTO "BoxOpening" ("boxItemId", "boxDefinitionId", "boxVersion", "userId", "boxSourceKey",
         "tierId", "contentId", "rewardDefinitionId", "rewardType", "tierWeight", "eligibleWeight",
         "tierRoll", "tierPoolSize", "itemRoll", "rewardStatus")
       VALUES (90, 4, 1, $1, 'box-a', 1, 1, 2, 'cosmetic', 1, 1, 0, 1, 0, 'granted')`,
      [BUYER]
    );

    await expect(refund('box-a')).resolves.toMatchObject({ ok: false });
    expect(await heldBoxes()).toEqual(['box-a']);
    expect(await openingStatus(90)).toBe('granted');
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
    expect(statements.slice(begin + 1, begin + 3)).toEqual([
      LOCK_TIMEOUT,
      {
        sql: 'SELECT pg_advisory_xact_lock($1::int, $2::int)',
        // The literal, not the shared constant: the main app locks under this number too.
        params: [1229455361, BUYER],
      },
    ]);
  });

  it('answers busy and changes nothing when the buyer’s lock is held', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await holdBox('box-a');
    lockFails.set(BUYER, '55P03');

    await expect(refund('box-a')).resolves.toEqual({ ok: false, error: ITEM_HOLDER_BUSY_MESSAGE });
    expect(await isRefunded('box-a')).toBe(false);
    expect(await heldBoxes()).toEqual(['box-a']);
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

  it('admits no reward status but granted and refunded', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await expect(openedBox('box-a', 77, 2, HAT)).resolves.toBeUndefined();
    await expect(
      db.query(`UPDATE "BoxOpening" SET "rewardStatus" = 'revoked' WHERE "boxItemId" = 77`)
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('still lists a pack (control)', async () => {
    await expect(list(PACK_LISTING)).resolves.toMatchObject({ affectedRows: 1 });
  });
});

describe('a take-back of something equipped refreshes the main app', () => {
  it('refunding an opened box whose hat is equipped names that hat and where it was', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await openedBox('box-a', 77, 2, HAT);
    await equip(HAT, 'box-open-77', IMAGE);

    await expect(refund('box-a')).resolves.toEqual({ ok: true });

    expect(mainApp).toEqual([
      {
        url: REFRESH_URL,
        afterCommit: true,
        body: {
          removed: [
            { userId: BUYER, cosmeticId: HAT, equippedToId: IMAGE.id, equippedToType: 'Image' },
          ],
        },
      },
    ]);
  });

  it('names only what was equipped, from a pack', async () => {
    await purchase('pack-a', PACK_LISTING, null);
    await grant(600, 'pack-a', BUYER, IMAGE);
    await grant(601, 'pack-a');

    await refund('pack-a');

    expect(mainApp.map((call) => call.body)).toEqual([
      {
        removed: [
          { userId: BUYER, cosmeticId: 600, equippedToId: IMAGE.id, equippedToType: 'Image' },
        ],
      },
    ]);
  });

  it('calls nothing when nothing taken back was equipped', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await openedBox('box-a', 77, 2, HAT);

    await refund('box-a');
    expect(mainApp).toEqual([]);
  });

  it('a refresh that fails still refunds, warns the moderator and logs the ids', async () => {
    mainAppAnswers = () => new Response('down', { status: 503 });
    await purchase('box-a', BOX_LISTING, null);
    await openedBox('box-a', 77, 2, HAT);
    await equip(HAT, 'box-open-77', IMAGE);

    await expect(refund('box-a')).resolves.toEqual({
      ok: true,
      warning:
        "Refunded. The site's caches didn't refresh, so it may keep showing on their profile and content until those expire.",
    });
    expect(await isRefunded('box-a')).toBe(true);
    expect(await holdings()).toEqual([]);
    expect(logAxiomError).toHaveBeenCalledWith(expect.any(Error), {
      event: 'moderator-holdings-refresh',
      userIds: [BUYER],
      cosmeticIds: [HAT],
    });
  });

  it('removing an equipped cosmetic names it; removing an unequipped one calls nothing', async () => {
    await grant(700, 'claimed', BUYER, IMAGE);
    await grant(600, 'claimed');

    await expect(
      removeCosmetic({ userId: BUYER, cosmeticId: 700, claimKey: 'claimed', moderatorId: MOD })
    ).resolves.toEqual({ ok: true });
    await removeCosmetic({ userId: BUYER, cosmeticId: 600, claimKey: 'claimed', moderatorId: MOD });

    expect(mainApp.map((call) => call.body)).toEqual([
      {
        removed: [
          { userId: BUYER, cosmeticId: 700, equippedToId: IMAGE.id, equippedToType: 'Image' },
        ],
      },
    ]);
  });

  it('a removal whose refresh fails still removes, warns the moderator and logs the ids', async () => {
    mainAppAnswers = () => new Response('down', { status: 503 });
    await grant(700, 'claimed', BUYER, IMAGE);

    await expect(
      removeCosmetic({ userId: BUYER, cosmeticId: 700, claimKey: 'claimed', moderatorId: MOD })
    ).resolves.toEqual({
      ok: true,
      warning:
        "Removed. The site's caches didn't refresh, so it may keep showing on their profile and content until those expire.",
    });
    expect(await holdings()).toEqual([]);
    expect(logAxiomError).toHaveBeenCalledWith(expect.any(Error), {
      event: 'moderator-holdings-refresh',
      userIds: [BUYER],
      cosmeticIds: [700],
    });
  });
});

describe('moderator grants take the item holder lock', () => {
  const lockedTransactions = () =>
    statements.flatMap((s, i) => (s.sql === 'begin' ? [statements.slice(i + 1, i + 3)] : []));
  // The leading keyword of each statement a transaction's own connection ran, so the grant is shown
  // inside the lock's transaction, not beside it.
  const transactions = () =>
    statements.flatMap((s, i) => {
      if (s.sql !== 'begin') return [];
      const conn = statementConnections[i];
      const end = statements.findIndex(
        (t, j) => j > i && t.sql === 'commit' && statementConnections[j] === conn
      );
      return [
        statements
          .slice(i + 1, end)
          .filter((_, k) => statementConnections[i + 1 + k] === conn)
          .map((t) => t.sql.trim().split(/\s+/)[0].toLowerCase()),
      ];
    });

  it('a single grant locks the user before inserting', async () => {
    await expect(
      grantCosmetic({ userId: BUYER, cosmeticId: 700, moderatorId: MOD })
    ).resolves.toEqual({ ok: true });
    expect(lockedTransactions()).toEqual([
      [
        LOCK_TIMEOUT,
        { sql: 'SELECT pg_advisory_xact_lock($1::int, $2::int)', params: [1229455361, BUYER] },
      ],
    ]);
    expect(transactions()).toEqual([['select', 'select', 'insert']]);
    expect(await holdings()).toEqual([{ userId: BUYER, cosmeticId: 700, claimKey: 'claimed' }]);
  });

  it('a single grant answers busy when the user’s lock is held', async () => {
    lockFails.set(BUYER, '55P03');

    await expect(
      grantCosmetic({ userId: BUYER, cosmeticId: 700, moderatorId: MOD })
    ).resolves.toEqual({ ok: false, error: ITEM_HOLDER_BUSY_MESSAGE });
    expect(await holdings()).toEqual([]);
  });

  it('a bulk grant skips a busy user, grants the rest, and names who was skipped', async () => {
    await db.exec(`INSERT INTO "User" ("id") VALUES (${BUYER}), (${OTHER})`);
    lockFails.set(BUYER, '55P03');

    await expect(
      grantCosmeticsToUsers({ cosmeticIds: [700], userIds: [BUYER, OTHER] })
    ).resolves.toEqual({ totalPairs: 2, alreadyOwned: 0, newlyGranted: 1, busyUserIds: [BUYER] });
    expect(await holdings()).toEqual([{ userId: OTHER, cosmeticId: 700, claimKey: 'claimed' }]);
  });

  it('a database error other than a lock timeout is not answered as busy', async () => {
    await db.exec(`INSERT INTO "User" ("id") VALUES (${BUYER}), (${OTHER})`);
    await purchase('box-a', BOX_LISTING, null);
    await holdBox('box-a');
    lockFails.set(BUYER, '40P01');

    await expect(refund('box-a')).rejects.toMatchObject({ code: '40P01' });
    await expect(
      grantCosmetic({ userId: BUYER, cosmeticId: 700, moderatorId: MOD })
    ).rejects.toMatchObject({ code: '40P01' });
    await expect(
      grantCosmeticsToUsers({ cosmeticIds: [700], userIds: [BUYER, OTHER] })
    ).rejects.toMatchObject({ code: '40P01' });
    expect(await isRefunded('box-a')).toBe(false);
    expect(await holdings()).toEqual([]);
  });

  it('a bulk grant locks each user in their own transaction', async () => {
    await db.exec(`INSERT INTO "User" ("id") VALUES (${BUYER}), (${OTHER})`);

    await grantCosmeticsToUsers({ cosmeticIds: [700], userIds: [BUYER, OTHER] });

    expect(lockedTransactions()).toEqual([
      [
        LOCK_TIMEOUT,
        { sql: 'SELECT pg_advisory_xact_lock($1::int, $2::int)', params: [1229455361, BUYER] },
      ],
      [
        LOCK_TIMEOUT,
        { sql: 'SELECT pg_advisory_xact_lock($1::int, $2::int)', params: [1229455361, OTHER] },
      ],
    ]);
    expect(transactions()).toEqual([
      ['select', 'select', 'insert'],
      ['select', 'select', 'insert'],
    ]);
    expect(await holdings()).toEqual([
      { userId: BUYER, cosmeticId: 700, claimKey: 'claimed' },
      { userId: OTHER, cosmeticId: 700, claimKey: 'claimed' },
    ]);
  });
});

describe('grantMysteryBoxes', () => {
  const grantBoxes = (overrides: Partial<Parameters<typeof grantMysteryBoxes>[0]> = {}) =>
    grantMysteryBoxes({
      boxId: 1,
      userIds: [BUYER, OTHER],
      count: 2,
      grantId: 'g1',
      moderatorId: MOD,
      ...overrides,
    });
  const items = async () =>
    (
      await db.query<{ itemDefinitionId: number; holderId: number; sourceKey: string }>(
        `SELECT "itemDefinitionId", "holderId", "sourceKey" FROM "Item" ORDER BY "sourceKey"`
      )
    ).rows;
  const purchases = async () =>
    (await db.query(`SELECT 1 FROM "UserCosmeticShopPurchases"`)).rows.length;

  beforeEach(async () => {
    await db.exec(`INSERT INTO "User" ("id") VALUES (${BUYER}), (${OTHER})`);
  });

  it('gives each user their boxes, unopened, under their own keys, with no purchase', async () => {
    await expect(grantBoxes()).resolves.toEqual({
      grantedUserIds: [BUYER, OTHER],
      alreadyGrantedUserIds: [],
      busyUserIds: [],
      failedUserIds: [],
    });
    expect(await items()).toEqual([
      { itemDefinitionId: 1, holderId: BUYER, sourceKey: `mod-grant-g1-${BUYER}-1` },
      { itemDefinitionId: 1, holderId: BUYER, sourceKey: `mod-grant-g1-${BUYER}-2` },
      { itemDefinitionId: 1, holderId: OTHER, sourceKey: `mod-grant-g1-${OTHER}-1` },
      { itemDefinitionId: 1, holderId: OTHER, sourceKey: `mod-grant-g1-${OTHER}-2` },
    ]);
    // The main app reads any purchase of a box as its having gone on sale.
    expect(await purchases()).toBe(0);
  });

  it('records the moderator against each user and the box', async () => {
    await grantBoxes();
    expect(recordModActivity.mock.calls).toEqual([
      [{ userId: MOD, entityType: 'user', entityId: BUYER, activity: 'grantBox:1:2:g1' }],
      [{ userId: MOD, entityType: 'user', entityId: OTHER, activity: 'grantBox:1:2:g1' }],
      [{ userId: MOD, entityType: 'mysteryBox', entityId: 1, activity: 'grantBox:2x2:g1' }],
    ]);
  });

  it('grants nothing more when the same form is submitted again', async () => {
    await grantBoxes();
    recordModActivity.mockClear();

    await expect(grantBoxes()).resolves.toEqual({
      grantedUserIds: [],
      alreadyGrantedUserIds: [BUYER, OTHER],
      busyUserIds: [],
      failedUserIds: [],
    });
    expect(await items()).toHaveLength(4);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('skips a busy user, and granting again with the same form finishes only them', async () => {
    lockFails.set(BUYER, '55P03');
    await expect(grantBoxes()).resolves.toEqual({
      grantedUserIds: [OTHER],
      alreadyGrantedUserIds: [],
      busyUserIds: [BUYER],
      failedUserIds: [],
    });
    expect((await items()).map((i) => i.holderId)).toEqual([OTHER, OTHER]);

    lockFails.clear();
    await expect(grantBoxes()).resolves.toEqual({
      grantedUserIds: [BUYER],
      alreadyGrantedUserIds: [OTHER],
      busyUserIds: [],
      failedUserIds: [],
    });
    expect((await items()).map((i) => i.holderId)).toEqual([BUYER, BUYER, OTHER, OTHER]);
  });

  it('locks each user in their own transaction before writing their boxes', async () => {
    await grantBoxes();
    const begins = statements.flatMap((st, i) => (st.sql === 'begin' ? [i] : []));
    expect(begins).toHaveLength(2);
    for (const [n, user] of [BUYER, OTHER].entries()) {
      const commit = statements.findIndex((st, i) => i > begins[n] && st.sql === 'commit');
      const own = statements.slice(begins[n] + 1, commit);
      expect(own.slice(0, 2).map((st) => st.params)).toEqual([
        [ITEM_HOLDER_LOCK_TIMEOUT],
        [1229455361, user],
      ]);
      expect(own.slice(2).map((st) => st.sql.trim().split(/\s+/)[0].toLowerCase())).toEqual([
        'select',
        'select',
        'insert',
      ]);
      expect(own.at(-1)?.params).toEqual(
        expect.arrayContaining([`mod-grant-g1-${user}-1`, `mod-grant-g1-${user}-2`])
      );
    }
  });

  // Throwing would end the request and lose the form's grant id while earlier users keep their
  // boxes, so the next attempt would give them a second set.
  it('reports a user whose grant fails for another reason, and goes on to the rest', async () => {
    lockFails.set(BUYER, '40P01');
    await expect(grantBoxes()).resolves.toEqual({
      grantedUserIds: [OTHER],
      alreadyGrantedUserIds: [],
      busyUserIds: [],
      failedUserIds: [BUYER],
    });
    expect((await items()).map((i) => i.holderId)).toEqual([OTHER, OTHER]);
  });

  it('gives nothing more to a user who already opened what this form gave', async () => {
    await grantBoxes({ userIds: [BUYER], count: 1 });
    await db.query(`DELETE FROM "Item"`);
    await openedBox(modGrantSourceKey('g1', BUYER, 1), 77, 2, HAT);

    await expect(grantBoxes({ userIds: [BUYER], count: 1 })).resolves.toMatchObject({
      grantedUserIds: [],
      alreadyGrantedUserIds: [BUYER],
    });
    expect(await items()).toEqual([]);
  });

  it('gives nothing more when the same form comes back with a higher count', async () => {
    await grantBoxes({ userIds: [BUYER], count: 1 });
    await expect(grantBoxes({ userIds: [BUYER], count: 3 })).resolves.toMatchObject({
      grantedUserIds: [],
      alreadyGrantedUserIds: [BUYER],
    });
    expect(await items()).toHaveLength(1);
  });

  it('tells apart users whose ids share a prefix', async () => {
    await db.exec(`INSERT INTO "User" ("id") VALUES (1), (12)`);
    await expect(grantBoxes({ userIds: [12, 1], count: 1 })).resolves.toMatchObject({
      grantedUserIds: [12, 1],
      alreadyGrantedUserIds: [],
    });
  });

  it("is not stopped by another grant id's boxes, nor by another user's", async () => {
    await grantBoxes({ userIds: [OTHER], count: 1 });
    await holdBox(modGrantSourceKey('g2', BUYER, 1));
    await expect(grantBoxes({ userIds: [BUYER], count: 1 })).resolves.toMatchObject({
      grantedUserIds: [BUYER],
    });
  });

  it.each([
    ['a draft box', { boxId: 5 }, 'Only a published box can be granted.'],
    ['an archived box', { boxId: 6 }, 'Only a published box can be granted.'],
    ["a creator's mystery pack", { boxId: 7 }, "A creator's mystery pack can't be granted."],
    ['a cosmetic', { boxId: 2 }, 'No such box.'],
    ['no box', { boxId: 999 }, 'No such box.'],
    ['a user who does not exist', { userIds: [BUYER, 4242] }, "These users don't exist: 4242"],
    ['no user', { userIds: [] }, 'Name at least one user.'],
    ['no boxes', { count: 0 }, 'Grant between 1 and 10 boxes each.'],
    ['too many boxes', { count: 11 }, 'Grant between 1 and 10 boxes each.'],
    ['a grant id a key cannot carry', { grantId: 'g-1' }, 'Not a grant id: g-1'],
  ])('refuses %s, writing nothing', async (_, overrides, message) => {
    await db.exec(`
      INSERT INTO "ItemDefinition" ("id", "type", "name", "status") VALUES
        (5, 'box', 'Draft box', 'draft'), (6, 'box', 'Old box', 'archived');
      INSERT INTO "ItemDefinition" ("id", "type", "name", "status", "sellerId") VALUES
        (7, 'box', 'Creator pack', 'published', ${OTHER});
    `);
    const refused = grantBoxes(overrides);
    await expect(refused).rejects.toBeInstanceOf(BoxGrantRefused);
    await expect(refused).rejects.toThrow(message);
    expect(await items()).toEqual([]);
    expect(recordModActivity).not.toHaveBeenCalled();
  });
});

describe('takeBackGrantedBox', () => {
  const GRANTED = modGrantSourceKey('g1', BUYER, 1);
  const takeBack = (sourceKey: string, userId = BUYER) =>
    takeBackGrantedBox({ userId, sourceKey, moderatorId: MOD });

  it('takes back a held granted box, and only that box', async () => {
    await holdBox(GRANTED);
    await holdBox(modGrantSourceKey('g1', BUYER, 2));

    await expect(takeBack(GRANTED)).resolves.toEqual({ ok: true });

    expect(await heldBoxes()).toEqual([modGrantSourceKey('g1', BUYER, 2)]);
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: MOD,
      entityType: 'user',
      entityId: BUYER,
      activity: `takeBackBox:${GRANTED}`,
    });
  });

  it('takes back what an opened granted box gave, keeping the opening on record', async () => {
    await openedBox(GRANTED, 77, 2, HAT);
    await grant(HAT, 'claimed');

    await expect(takeBack(GRANTED)).resolves.toEqual({ ok: true });

    expect(await holdings()).toEqual([{ userId: BUYER, cosmeticId: HAT, claimKey: 'claimed' }]);
    expect(await openingStatus(77)).toBe('refunded');
    expect(bustUserCosmeticCaches).toHaveBeenCalledWith(BUYER);
  });

  it('refuses a second take-back, changing nothing', async () => {
    await openedBox(GRANTED, 77, 2, HAT);
    await takeBack(GRANTED);
    recordModActivity.mockClear();

    await expect(takeBack(GRANTED)).resolves.toEqual({
      ok: false,
      error: 'Neither the box nor what it gave is on this account.',
    });
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('will not take back a bought box: that is a refund', async () => {
    await purchase('box-a', BOX_LISTING, null);
    await holdBox('box-a');

    await expect(takeBack('box-a')).resolves.toEqual({
      ok: false,
      error: 'That box was not granted by a moderator.',
    });
    expect(await heldBoxes()).toEqual(['box-a']);
    expect(await isRefunded('box-a')).toBe(false);
  });

  it('does not reach another user’s granted box', async () => {
    await holdBox(GRANTED, OTHER);

    await expect(takeBack(GRANTED)).resolves.toMatchObject({ ok: false });
    expect(await heldBoxes()).toEqual([GRANTED]);
  });

  it('answers busy and changes nothing when the user’s lock is held', async () => {
    await holdBox(GRANTED);
    lockFails.set(BUYER, '55P03');

    await expect(takeBack(GRANTED)).resolves.toEqual({
      ok: false,
      error: ITEM_HOLDER_BUSY_MESSAGE,
    });
    expect(await heldBoxes()).toEqual([GRANTED]);
  });

  it('takes the lock before reading which box it is', async () => {
    await holdBox(GRANTED);
    await takeBack(GRANTED);

    const begin = statements.findIndex((st) => st.sql === 'begin');
    expect(statements.slice(begin + 1, begin + 3)).toEqual([
      LOCK_TIMEOUT,
      { sql: 'SELECT pg_advisory_xact_lock($1::int, $2::int)', params: [1229455361, BUYER] },
    ]);
  });
});
