import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import {
  boxOddsSnapshotSchema,
  snapshotOfLiveBox,
  snapshotsMatch,
} from '@civitai/shared/box-odds-snapshot';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as ErrorHandling from '~/server/utils/errorHandling';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A single-item takedown of a cosmetic that boxes hold: on in-process Postgres with the real mystery
 * box migrations for the box half, which is all raw SQL. The shelf half runs on the db mock with no
 * sales, and Buzz is faked.
 */

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  // Run inside the next transaction, just before its first statement containing `marker`.
  before: null as null | { marker: string; sql: string[] },
}));

const buzz = vi.hoisted(() => ({
  createBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
  refundTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getTransactionByExternalId: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => buzz);
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('~/server/services/cosmetic.service', () => ({
  revokeCosmeticsFromUsers: vi.fn().mockResolvedValue({ revoked: 0 }),
  validateStickerCosmetic: vi.fn(),
}));
vi.mock('~/server/services/placement-moderation.service', () => ({
  removePlacementsByCosmetic: vi.fn().mockResolvedValue({
    considered: 0,
    settled: 0,
    failed: [],
    takenDown: 0,
    hasMore: false,
  }),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembership: vi.fn(),
}));
const notifications = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/notification.service', () => notifications);
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: (_options: unknown, operation: () => Promise<unknown>) => operation(),
}));
// No wall-clock backoff on a retry.
vi.mock('~/server/utils/errorHandling', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorHandling>();
  return {
    ...actual,
    withRetries: (fn: () => Promise<unknown>, retries = 3) => actual.withRetries(fn, retries, 0),
  };
});

type Raw = ReturnType<typeof pgliteRaw>;
const bridge = (tx: { query: PGlite['query'] }) => {
  const raw = pgliteRaw(tx as PGlite);
  const hooked =
    (run: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const before = holder.before;
      if (before && strings.join('?').includes(before.marker)) {
        holder.before = null;
        for (const statement of before.sql) await tx.query(statement);
      }
      return run(strings, ...values);
    };
  return { $executeRaw: hooked(raw.executeRaw), $queryRaw: hooked(raw.queryRaw) };
};
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
  holder.db.transaction((tx) => fn(bridge(tx)))) as never);

const { takedownCosmeticShopItem } = await import('~/server/services/creator-shop.service');

const MIGRATIONS = [
  '20261105120000_mystery_box_items',
  '20261107120000_mystery_box_listing_unlisted_and_refunds',
  '20261108120000_creator_mystery_packs',
].map((name) =>
  readFileSync(
    join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`),
    'utf8'
  )
);

const MOD = 1;
const BUYER = 101;
const GRANTEE = 102;
const CREATOR = 10;
const TAKEN_DOWN = 7;
const KEPT = 8;
const SHELF_LISTING = 42;

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

beforeAll(async () => {
  holder.db = new PGlite();
  // Stand-ins for the tables the migrations reference, with the columns this code touches.
  await holder.db.exec(`
    CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'Sticker');
    CREATE TYPE "CosmeticShopItemStatus" AS ENUM ('Draft', 'PendingReview', 'Published', 'Rejected', 'RequestedChanges', 'Archived');
    CREATE TABLE "User" (id int PRIMARY KEY);
    CREATE TABLE "Cosmetic" (
      id int PRIMARY KEY, name text NOT NULL, type "CosmeticType" NOT NULL, data jsonb, "createdById" int
    );
    CREATE TABLE "CosmeticShopItem" (
      id serial PRIMARY KEY,
      "cosmeticId" int,
      "unitAmount" int NOT NULL,
      title text NOT NULL,
      meta jsonb NOT NULL DEFAULT '{}',
      status "CosmeticShopItemStatus" NOT NULL DEFAULT 'Published',
      listed boolean NOT NULL DEFAULT true
    );
    CREATE TABLE "UserCosmeticShopPurchases" (
      "buzzTransactionId" text PRIMARY KEY, "userId" int NOT NULL, "shopItemId" int NOT NULL,
      "unitAmount" int NOT NULL, refunded boolean NOT NULL, meta jsonb
    );
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(migration);
});

/** A box with two tiers holding both cosmetics; returns its id and the taken-down reward's id. */
const seedBox = async ({
  status = 'published',
  sellerId = null as number | null,
  snapshot,
}: { status?: string; sellerId?: number | null; snapshot?: object } = {}) => {
  const [{ id: boxId }] = await q<{ id: number }>(
    `INSERT INTO "ItemDefinition" (type, name, status, "sellerId") VALUES ('box', 'Box', $1, $2) RETURNING id`,
    [status, sellerId]
  );
  const [common, rare] = await q<{ id: number }>(
    `INSERT INTO "BoxTier" ("boxDefinitionId", key, name, weight, "sortOrder")
     VALUES ($1, 'common', 'Common', 90, 0), ($1, 'rare', 'Rare', 10, 1) RETURNING id`,
    [boxId]
  );
  await q(
    `INSERT INTO "BoxContent" ("boxDefinitionId", "tierId", "rewardDefinitionId")
     SELECT $1, $2, id FROM "ItemDefinition" WHERE "cosmeticId" = ${TAKEN_DOWN}`,
    [boxId, rare.id]
  );
  await q(
    `INSERT INTO "BoxContent" ("boxDefinitionId", "tierId", "rewardDefinitionId")
     SELECT $1, $2, id FROM "ItemDefinition" WHERE "cosmeticId" = ${KEPT}`,
    [boxId, common.id]
  );
  if (status !== 'draft')
    await q(
      `INSERT INTO "BoxOddsSnapshot" ("boxDefinitionId", version, snapshot) VALUES ($1, 1, $2)`,
      [boxId, JSON.stringify(snapshot ?? (await liveSnapshot(boxId)))]
    );
  return boxId;
};

/** The odds page's `historyComplete` read: the snapshot at the box's version against its live rows. */
const liveSnapshot = async (boxId: number) => {
  const tiers = await q<{
    id: number;
    key: string;
    name: string;
    weight: number;
    sortOrder: number;
  }>(`SELECT id, key, name, weight, "sortOrder" FROM "BoxTier" WHERE "boxDefinitionId" = $1`, [
    boxId,
  ]);
  const contents = await q<{ tierId: number; cosmeticId: number }>(
    `SELECT bc."tierId", d."cosmeticId" FROM "BoxContent" bc
     JOIN "ItemDefinition" d ON d.id = bc."rewardDefinitionId"
     WHERE bc."boxDefinitionId" = $1 AND bc.enabled`,
    [boxId]
  );
  return snapshotOfLiveBox(tiers, contents);
};

const boxState = async (boxId: number) => {
  const [{ version }] = await q<{ version: number }>(
    `SELECT version FROM "ItemDefinition" WHERE id = $1`,
    [boxId]
  );
  const [current] = await q<{ snapshot: unknown }>(
    `SELECT snapshot FROM "BoxOddsSnapshot" WHERE "boxDefinitionId" = $1 AND version = $2`,
    [boxId, version]
  );
  const offered = (
    await q<{ cosmeticId: number }>(
      `SELECT d."cosmeticId" FROM "BoxContent" bc
       JOIN "ItemDefinition" d ON d.id = bc."rewardDefinitionId"
       WHERE bc."boxDefinitionId" = $1 AND bc.enabled ORDER BY 1`,
      [boxId]
    )
  ).map((row) => row.cosmeticId);
  return { version, snapshot: current?.snapshot, offered };
};

let nextBoxItem = 1;
/** A box listing, a purchase of it, and the opening that drew the taken-down cosmetic. */
const seedOpening = async (
  boxId: number,
  {
    userId = BUYER,
    sourceKey = `box-purchase-${nextBoxItem}`,
    purchased = true,
    meta = null as object | null,
  } = {}
) => {
  const boxItemId = nextBoxItem++;
  if (purchased) {
    const [{ id: listingId }] = await q<{ id: number }>(
      `INSERT INTO "CosmeticShopItem" ("unitAmount", title, "itemDefinitionId", listed)
       VALUES (800, 'Box listing', $1, false) RETURNING id`,
      [boxId]
    );
    await q(
      `INSERT INTO "UserCosmeticShopPurchases" ("buzzTransactionId", "userId", "shopItemId", "unitAmount", refunded, meta)
       VALUES ($1, $2, $3, 800, false, $4)`,
      [sourceKey, userId, listingId, meta && JSON.stringify(meta)]
    );
  }
  await q(
    `INSERT INTO "BoxOpening" ("boxItemId", "boxDefinitionId", "boxVersion", "userId", "boxSourceKey",
       "tierId", "contentId", "rewardDefinitionId", "rewardType", "tierWeight", "eligibleWeight",
       "tierRoll", "tierPoolSize", "itemRoll", "rewardStatus")
     SELECT $1, $2, 1, $3, $4, 0, 0, id, 'cosmetic', 10, 100, 0, 1, 0, 'granted'
     FROM "ItemDefinition" WHERE "cosmeticId" = ${TAKEN_DOWN}`,
    [boxItemId, boxId, userId, sourceKey]
  );
  return { boxItemId, sourceKey };
};

const rewardStatusOf = async (boxItemId: number) =>
  (
    await q<{ rewardStatus: string }>(
      `SELECT "rewardStatus" FROM "BoxOpening" WHERE "boxItemId" = $1`,
      [boxItemId]
    )
  )[0].rewardStatus;

const purchaseRefunded = async (sourceKey: string) =>
  (
    await q<{ refunded: boolean }>(
      `SELECT refunded FROM "UserCosmeticShopPurchases" WHERE "buzzTransactionId" = $1`,
      [sourceKey]
    )
  )[0].refunded;

/** What the moderator app's box refund writes, under the same holder lock. */
const moderatorRefundSql = (sourceKey: string) => [
  `UPDATE "UserCosmeticShopPurchases" SET refunded = true WHERE "buzzTransactionId" = '${sourceKey}' AND NOT refunded`,
  `UPDATE "BoxOpening" SET "rewardStatus" = 'refunded' WHERE "boxSourceKey" = '${sourceKey}' AND "rewardStatus" = 'granted'`,
];

const takedown = () =>
  takedownCosmeticShopItem({ id: SHELF_LISTING, reason: 'Infringing', moderatorId: MOD });

const refundedPrefixes = () =>
  buzz.refundMultiAccountTransaction.mock.calls.map(
    ([input]) => (input as { externalTransactionIdPrefix: string }).externalTransactionIdPrefix
  );

beforeEach(async () => {
  holder.before = null;
  for (const fn of Object.values(buzz)) fn.mockReset();
  buzz.refundMultiAccountTransaction.mockResolvedValue({
    refundedTransactions: [],
    totalRefunded: 800,
    externalTransactionIdPrefix: 'p',
  });
  buzz.refundTransaction.mockResolvedValue({ transactionId: 'refund-tx' });
  notifications.createNotification.mockReset().mockResolvedValue(undefined);
  await holder.db.exec(`
    TRUNCATE "BoxOddsSnapshot", "BoxOpening", "BoxContent", "BoxTier", "CosmeticShopItem", "UserCosmeticShopPurchases" RESTART IDENTITY CASCADE;
    DELETE FROM "ItemDefinition";
    DELETE FROM "Cosmetic";
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${CREATOR});
    INSERT INTO "Cosmetic" (id, name, type, data, "createdById")
      VALUES (${TAKEN_DOWN}, 'Taken down', 'Badge', '{}', ${CREATOR}), (${KEPT}, 'Kept', 'Badge', '{}', ${CREATOR});
    INSERT INTO "ItemDefinition" (type, name, status, "cosmeticId")
      VALUES ('cosmetic', 'Taken down', 'published', ${TAKEN_DOWN}), ('cosmetic', 'Kept', 'published', ${KEPT});
  `);

  // The shelf listing being taken down, with no sales of its own.
  const shelfItem = {
    id: SHELF_LISTING,
    cosmeticId: TAKEN_DOWN,
    title: 'Taken down',
    meta: {},
    addedById: CREATOR,
    itemDefinitionId: null,
    cosmetic: { createdById: CREATOR, creator: { username: 'creator' } },
  };
  dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue(shelfItem);
  dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({ meta: {} });
  dbMock.dbWrite.cosmeticShopItem.update.mockResolvedValue(shelfItem);
  dbMock.dbWrite.cosmeticShopItem.updateMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockResolvedValue([]);
  dbMock.dbRead.user.findUnique.mockResolvedValue({ settings: {} });
});

describe('takedownCosmeticShopItem on a cosmetic boxes hold', () => {
  it('takes it out of every box, with a new version whose snapshot matches the live box', async () => {
    const published = await seedBox();
    const draft = await seedBox({ status: 'draft' });

    const result = await takedown();

    const after = await boxState(published);
    expect(after.offered).toEqual([KEPT]);
    expect(after.version).toBe(2);
    // The odds page reads `historyComplete` this way; false would flag the box as misreported.
    expect(
      snapshotsMatch(boxOddsSnapshotSchema.parse(after.snapshot), await liveSnapshot(published))
    ).toBe(true);
    // A draft is shown nowhere, so it gets a version and no snapshot, as a builder save does.
    expect(await boxState(draft)).toEqual({ version: 2, snapshot: undefined, offered: [KEPT] });
    expect(result.boxesPulled).toBe(2);
    expect(result.failures).toEqual([]);
  });

  it("keeps a creator box's price and values in the new snapshot", async () => {
    const boxId = await seedBox({
      sellerId: CREATOR,
      snapshot: {
        tiers: [
          { key: 'common', name: 'Common', weight: 90 },
          { key: 'rare', name: 'Rare', weight: 10 },
        ],
        contents: [
          { tier: 'common', cosmeticId: KEPT, value: 300 },
          { tier: 'rare', cosmeticId: TAKEN_DOWN, value: 900 },
        ],
        price: 500,
      },
    });

    await takedown();

    expect((await boxState(boxId)).snapshot).toEqual({
      tiers: [
        { key: 'common', name: 'Common', weight: 90 },
        { key: 'rare', name: 'Rare', weight: 10 },
      ],
      contents: [{ tier: 'common', cosmeticId: KEPT, value: 300 }],
      price: 500,
    });
  });

  // The shelf buyers' refunds and the revoke still have to run.
  it('finishes the takedown when the boxes holding it cannot be read', async () => {
    await seedBox();
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));

    const result = await takedown();

    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'box', boxId: 0, error: expect.stringContaining('reset') }),
    ]);
  });

  it('refunds a box buyer who drew it, once, and marks the opening refunded', async () => {
    const boxId = await seedBox();
    const { boxItemId, sourceKey } = await seedOpening(boxId);

    const first = await takedown();
    // Run again, as a moderator finishing a partial takedown would.
    const second = await takedown();

    expect(refundedPrefixes()).toEqual([sourceKey]);
    expect(await rewardStatusOf(boxItemId)).toBe('refunded');
    expect(await purchaseRefunded(sourceKey)).toBe(true);
    expect([first.boxOpeningsRefunded, first.boxRefundedValue]).toEqual([1, 800]);
    expect(second.boxOpeningsRefunded).toBe(0);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cosmetic-shop-item-taken-down', userId: BUYER })
    );
  });

  it('marks a moderator-granted opening refunded and moves no Buzz', async () => {
    const boxId = await seedBox();
    const { boxItemId } = await seedOpening(boxId, {
      userId: GRANTEE,
      sourceKey: 'mod-grant-5-102-0',
      purchased: false,
    });

    const result = await takedown();

    expect(await rewardStatusOf(boxItemId)).toBe('refunded');
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(result.boxOpeningsRefunded).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('does not refund a box purchase a moderator already refunded', async () => {
    const boxId = await seedBox();
    const { boxItemId, sourceKey } = await seedOpening(boxId);
    for (const statement of moderatorRefundSql(sourceKey)) await q(statement);

    await takedown();

    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(await rewardStatusOf(boxItemId)).toBe('refunded');
  });

  // The moderator refund commits after the takedown read the openings and before it claimed this
  // one: it waited on the same holder lock.
  it('does not refund a box purchase a moderator refunds while the takedown runs', async () => {
    const boxId = await seedBox();
    const raced = await seedOpening(boxId);
    const other = await seedOpening(boxId, { userId: 103 });
    holder.before = { marker: 'UPDATE "BoxOpening"', sql: moderatorRefundSql(raced.sourceKey) };

    await takedown();

    expect(holder.before).toBeNull();
    expect(refundedPrefixes()).toEqual([other.sourceKey]);
  });

  it("reverses a box sale's recorded payouts as a shelf sale's are", async () => {
    const boxId = await seedBox({ sellerId: CREATOR });
    await seedOpening(boxId, {
      meta: {
        payouts: [{ userId: CREATOR, amount: 560, color: 'yellow', transactionId: 'payout-1' }],
      },
    });

    const result = await takedown();

    expect(buzz.refundTransaction).toHaveBeenCalledWith('payout-1', expect.any(String));
    expect(result.clawedBack).toBe(560);
  });

  // Unreachable while creator boxes are not sold; kept so the first sale without a record is loud.
  it('leaves a creator box sale with no payout record to a moderator, against the creator', async () => {
    const boxId = await seedBox({ sellerId: CREATOR });
    await seedOpening(boxId);

    const result = await takedown();

    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'clawback', userId: CREATOR, boxId }),
    ]);
  });
});
