import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import {
  boxOddsSnapshotSchema,
  snapshotOfLiveBox,
  snapshotsMatch,
} from '@civitai/shared/box-odds-snapshot';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as CreatorShopLabels from '~/server/services/creator-shop-labels.service';
import type * as ErrorHandling from '~/server/utils/errorHandling';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A single-item takedown of a cosmetic that boxes hold: on in-process Postgres with the real mystery
 * box migrations for the box half, which is all raw SQL. The shelf half runs on the db mock with no
 * sales, and Buzz is faked.
 */

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  // Run inside the next transaction, just before its first statement containing `marker`; with
  // `persist`, in every transaction that reaches it.
  before: null as null | { marker: string; sql: string[]; persist?: boolean },
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
vi.mock('~/server/services/creator-shop-labels.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorShopLabels>()),
  recordShopTakedownLabel: vi.fn(async () => undefined),
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
        if (!before.persist) holder.before = null;
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

/**
 * The writes the moderator app's box refund makes (`refundShopPurchase` / `takeBackBox` in
 * apps/moderator; Kysely there, so copied rather than imported). Injected inside the takedown's
 * claim transaction, standing in for that refund committing first under the holder lock.
 */
const moderatorRefundSql = (sourceKey: string) => [
  `UPDATE "UserCosmeticShopPurchases" SET refunded = true WHERE "buzzTransactionId" = '${sourceKey}' AND NOT refunded`,
  `UPDATE "BoxOpening" SET "rewardStatus" = 'refunded' WHERE "boxSourceKey" = '${sourceKey}' AND "rewardStatus" = 'granted'`,
];

const refunded800 = {
  refundedTransactions: [
    {
      originalTransactionId: 'charge-1',
      refundTransactionId: 'refund-1',
      accountType: 'yellow',
      amount: 800,
      originalExternalTransactionId: 'e',
    },
  ],
  totalRefunded: 800,
  externalTransactionIdPrefix: 'p',
};

const takedown = () =>
  takedownCosmeticShopItem({ id: SHELF_LISTING, reason: 'Infringing', moderatorId: MOD });

const refundedPrefixes = () =>
  buzz.refundMultiAccountTransaction.mock.calls.map(
    ([input]) => (input as { externalTransactionIdPrefix: string }).externalTransactionIdPrefix
  );
// Shelf purchases are reversed leg by leg from their ledger, box purchases by prefix.
const refundedLegs = () => buzz.refundTransaction.mock.calls.map(([id]) => id);

/** Each shelf sale's ledger, by purchase id: the buyer's 500 debit, and no payout. */
const shelfLedger = (buyers: Record<string, number>) =>
  buzz.getMultiAccountTransactionsByPrefix.mockImplementation((async (prefix: string) =>
    prefix in buyers
      ? [
          {
            transactionId: `${prefix}-debit`,
            externalTransactionId: `${prefix}-yellow`,
            accountId: buyers[prefix],
            amount: 500,
          },
        ]
      : []) as never);

beforeEach(async () => {
  holder.before = null;
  for (const fn of Object.values(buzz)) fn.mockReset();
  buzz.refundMultiAccountTransaction.mockResolvedValue(refunded800);
  buzz.refundTransaction.mockResolvedValue({ transactionId: 'refund-tx' });
  buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([]);
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

  it('still refunds the shelf buyers when the boxes holding it cannot be read', async () => {
    await seedBox();
    dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockResolvedValue([
      { userId: 104, buzzTransactionId: 'shelf-1', unitAmount: 500, meta: { payouts: [] } },
    ]);
    shelfLedger({ 'shelf-1': 104 });
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));

    const result = await takedown();

    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'box', boxId: 0, error: expect.stringContaining('reset') }),
    ]);
    expect([result.refunded, refundedLegs()]).toEqual([1, ['shelf-1-debit']]);
  });

  it('refunds a box buyer who drew it, once, and marks the opening refunded', async () => {
    const boxId = await seedBox();
    const { boxItemId, sourceKey } = await seedOpening(boxId);
    // The same buyer also bought it off the shelf: told once.
    dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockResolvedValueOnce([
      { userId: BUYER, buzzTransactionId: 'shelf-1', unitAmount: 500, meta: { payouts: [] } },
    ]);
    shelfLedger({ 'shelf-1': BUYER });

    const first = await takedown();
    // A second run of the same takedown finds nothing left to pay.
    const second = await takedown();

    expect([refundedLegs(), refundedPrefixes()]).toEqual([['shelf-1-debit'], [sourceKey]]);
    expect(await rewardStatusOf(boxItemId)).toBe('refunded');
    expect(await purchaseRefunded(sourceKey)).toBe(true);
    expect([first.boxOpeningsRefunded, first.boxRefundedValue]).toEqual([1, 800]);
    expect(second.boxOpeningsRefunded).toBe(0);
    expect(
      notifications.createNotification.mock.calls.filter(
        ([n]) => n.type === 'cosmetic-shop-item-taken-down' && n.userId === BUYER
      )
    ).toHaveLength(1);
  });

  // The purchase is flagged refunded before the Buzz moves, so the flag alone would hide what is
  // owed: the stamp keeps it owed, and running the takedown again pays it.
  it('keeps a failed box refund owed, and pays it when the takedown runs again', async () => {
    const boxId = await seedBox();
    const { sourceKey } = await seedOpening(boxId);
    buzz.refundMultiAccountTransaction.mockRejectedValue(new Error('buzz is down'));

    const failed = await takedown();

    expect(failed.failures).toEqual([
      expect.objectContaining({ stage: 'refund', userId: BUYER, amount: 800, boxId }),
    ]);
    expect(failed.boxOpeningsRefunded).toBe(0);
    expect(notifications.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cosmetic-shop-item-taken-down' })
    );

    buzz.refundMultiAccountTransaction.mockReset().mockResolvedValue(refunded800);
    const retried = await takedown();

    expect(refundedPrefixes()).toEqual([sourceKey]);
    expect([retried.boxOpeningsRefunded, retried.failures]).toEqual([1, []]);
  });

  // An attempt whose response was lost is answered 409 on its retry: the refund landed.
  it('counts a box refund refused as already made as paid, and makes no other', async () => {
    const boxId = await seedBox();
    const { sourceKey } = await seedOpening(boxId);
    buzz.refundMultiAccountTransaction.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'conflict', cause: new BuzzApiError(409, 'x') })
    );
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      { transactionId: 'charge-1', amount: 800 },
    ]);
    buzz.getTransactionByExternalId.mockResolvedValue({ transactionId: 'refund-charge-1' });

    const result = await takedown();

    expect([result.boxOpeningsRefunded, result.failures]).toEqual([1, []]);
    // Asked twice (the plain refund, then the finishing helper's own attempt), and nothing more.
    expect(new Set(refundedPrefixes())).toEqual(new Set([sourceKey]));
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
  });

  it('leaves an opening granted, and reports it, when its claim keeps failing', async () => {
    const boxId = await seedBox();
    const { boxItemId } = await seedOpening(boxId);
    holder.before = { marker: 'UPDATE "BoxOpening"', sql: ['SELECT 1/0'], persist: true };

    const result = await takedown();

    expect(await rewardStatusOf(boxItemId)).toBe('granted');
    expect(result.failures).toEqual([
      expect.objectContaining({
        stage: 'box',
        userId: BUYER,
        error: expect.stringContaining('zero'),
      }),
    ]);
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  // Openers are read after the pull commits, so one that drew it just before is still found.
  it('refunds an opener whose draw committed just before the pull', async () => {
    const boxId = await seedBox();
    await q(
      `INSERT INTO "CosmeticShopItem" ("unitAmount", title, "itemDefinitionId", listed)
       VALUES (800, 'Box listing', $1, false)`,
      [boxId]
    );
    holder.before = {
      marker: 'UPDATE "BoxContent"',
      sql: [
        `INSERT INTO "UserCosmeticShopPurchases" ("buzzTransactionId", "userId", "shopItemId", "unitAmount", refunded)
         SELECT 'late-1', ${BUYER}, id, 800, false FROM "CosmeticShopItem" WHERE "itemDefinitionId" = ${boxId}`,
        `INSERT INTO "BoxOpening" ("boxItemId", "boxDefinitionId", "boxVersion", "userId", "boxSourceKey",
           "tierId", "contentId", "rewardDefinitionId", "rewardType", "tierWeight", "eligibleWeight",
           "tierRoll", "tierPoolSize", "itemRoll", "rewardStatus")
         SELECT 900, ${boxId}, 1, ${BUYER}, 'late-1', 0, 0, id, 'cosmetic', 10, 100, 0, 1, 0, 'granted'
         FROM "ItemDefinition" WHERE "cosmeticId" = ${TAKEN_DOWN}`,
      ],
    };

    await takedown();

    expect(holder.before).toBeNull();
    expect(refundedPrefixes()).toEqual(['late-1']);
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

  // Each of the claim's two guards on its own: the moderator refund flips both, these flip one.
  it('does not refund a box purchase already flagged refunded', async () => {
    const boxId = await seedBox();
    const { sourceKey } = await seedOpening(boxId);
    await q(
      `UPDATE "UserCosmeticShopPurchases" SET refunded = true WHERE "buzzTransactionId" = $1`,
      [sourceKey]
    );

    await takedown();

    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('does not refund an opening refunded between the read and its claim', async () => {
    const boxId = await seedBox();
    const { sourceKey } = await seedOpening(boxId);
    holder.before = { marker: 'UPDATE "BoxOpening"', sql: [moderatorRefundSql(sourceKey)[1]] };

    await takedown();

    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(await purchaseRefunded(sourceKey)).toBe(false);
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

    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([]);

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

/**
 * Runs `run` with every top-level raw statement containing `marker` rejected, and returns how many
 * were: a marker that matches nothing fails nothing, and the test would pass as the happy path.
 */
const withFailing = async <T>(
  method: '$queryRaw' | '$executeRaw',
  marker: string,
  run: () => Promise<T>
) => {
  const raw = () => pgliteRaw(holder.db)[method === '$queryRaw' ? 'queryRaw' : 'executeRaw'];
  let hits = 0;
  dbMock.dbWrite[method].mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (!strings.join('?').includes(marker)) return raw()(strings, ...values);
    hits++;
    return Promise.reject(new Error(`${marker} failed`));
  }) as never);
  try {
    return { result: await run(), hits };
  } finally {
    dbMock.dbWrite[method].mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => raw()(strings, ...values)) as never);
  }
};

describe('takedownCosmeticShopItem paying box refunds still owed', () => {
  it('pays a box refund still owed, though the box no longer lists the content', async () => {
    const boxId = await seedBox();
    const { sourceKey } = await seedOpening(boxId);
    buzz.refundMultiAccountTransaction.mockRejectedValue(new Error('buzz is down'));
    await takedown();
    // A builder save that drops the disabled content deletes its row.
    await q(`DELETE FROM "BoxContent" WHERE NOT enabled`);
    buzz.refundMultiAccountTransaction.mockReset().mockResolvedValue(refunded800);

    const retried = await takedown();

    expect(refundedPrefixes()).toEqual([sourceKey]);
    expect(retried.boxOpeningsRefunded).toBe(1);
  });

  // A 404 reads as zeros in the prefix refund; a recorded purchase means its charge happened.
  it('keeps a box refund owed when Buzz lists no charge under it', async () => {
    const boxId = await seedBox();
    await seedOpening(boxId);
    buzz.refundMultiAccountTransaction.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'none', cause: new BuzzApiError(404, 'x') })
    );

    const result = await takedown();

    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'refund', userId: BUYER, amount: 800 }),
    ]);
    expect(result.boxOpeningsRefunded).toBe(0);
    buzz.refundMultiAccountTransaction.mockReset().mockResolvedValue(refunded800);
    expect((await takedown()).boxOpeningsRefunded).toBe(1);
  });

  it('finishes the takedown, and pays nothing twice, when a paid refund cannot be marked', async () => {
    const boxId = await seedBox();
    const first = await seedOpening(boxId);
    const second = await seedOpening(boxId, { userId: 103 });
    const { result, hits } = await withFailing('$executeRaw', 'jsonb_set', takedown);

    expect(hits).toBe(2);
    expect(refundedPrefixes()).toEqual([first.sourceKey, second.sourceKey]);
    expect([result.boxOpeningsRefunded, result.failures]).toEqual([2, []]);
    // The retry asks the prefix again; Buzz answers that it is already refunded.
    buzz.refundMultiAccountTransaction.mockReset().mockRejectedValue(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'conflict',
        cause: new BuzzApiError(409, 'x'),
      })
    );
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      { transactionId: 'charge-1', amount: 800 },
    ]);
    buzz.getTransactionByExternalId.mockResolvedValue({ transactionId: 'refund-charge-1' });
    await takedown();
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
  });

  it('still refunds the shelf buyers when the owed box refunds cannot be read', async () => {
    const boxId = await seedBox();
    await seedOpening(boxId);
    dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockResolvedValue([
      { userId: 104, buzzTransactionId: 'shelf-1', unitAmount: 500, meta: { payouts: [] } },
    ]);
    shelfLedger({ 'shelf-1': 104 });
    const { result, hits } = await withFailing(
      '$queryRaw',
      'o."boxSourceKey" AND p."userId"',
      takedown
    );

    expect(hits).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'box', error: expect.stringContaining('not read') }),
    ]);
    expect([refundedLegs(), refundedPrefixes()]).toEqual([['shelf-1-debit'], []]);
  });

  // The source key is a string; only the purchase of that box, by that opener, is the box's sale.
  it('leaves alone a purchase that shares the source key but is not the box sale', async () => {
    const boxId = await seedBox();
    const otherBox = await seedBox();
    const { sourceKey } = await seedOpening(boxId, { purchased: false });
    const [{ id: otherListing }] = await q<{ id: number }>(
      `INSERT INTO "CosmeticShopItem" ("unitAmount", title, "itemDefinitionId", listed)
       VALUES (800, 'Other box', $1, false) RETURNING id`,
      [otherBox]
    );
    await q(
      `INSERT INTO "UserCosmeticShopPurchases" ("buzzTransactionId", "userId", "shopItemId", "unitAmount", refunded)
       VALUES ($1, $2, $3, 800, false)`,
      [sourceKey, BUYER, otherListing]
    );

    await takedown();

    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(await purchaseRefunded(sourceKey)).toBe(false);
  });

  // An earlier attempt refunded the buyer and died: the retry pays the buyer nothing twice and still
  // reverses the payout.
  it('finishes a shelf refund an earlier attempt half made, and reverses its seller payout', async () => {
    await seedBox();
    dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockResolvedValue([
      {
        userId: 104,
        buzzTransactionId: 'shelf-1',
        unitAmount: 500,
        meta: {
          payouts: [{ userId: CREATOR, amount: 350, color: 'yellow', transactionId: 'payout-9' }],
        },
      },
    ]);
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      {
        transactionId: 'charge-9',
        externalTransactionId: 'shelf-1-yellow',
        accountId: 104,
        amount: 500,
      },
      {
        transactionId: 'payout-9',
        externalTransactionId: `shelf-1:sell:${CREATOR}:yellow`,
        accountId: 0,
        amount: 350,
      },
    ]);
    buzz.getTransactionByExternalId.mockImplementation((async (id: string) =>
      id === 'refund-charge-9' ? { transactionId: id } : null) as never);

    const result = await takedown();

    expect([result.refunded, result.failures, result.clawedBack]).toEqual([1, [], 350]);
    expect(refundedLegs()).toEqual(['payout-9']);
  });

  it('reverses the leg an earlier shelf refund attempt left, and flags the purchase refunded', async () => {
    await seedBox();
    dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockResolvedValue([
      { userId: 104, buzzTransactionId: 'shelf-1', unitAmount: 500, meta: { payouts: [] } },
    ]);
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      { transactionId: 'a', externalTransactionId: 'shelf-1-yellow', accountId: 104, amount: 300 },
      { transactionId: 'b', externalTransactionId: 'shelf-1-blue', accountId: 104, amount: 200 },
    ]);
    const refunds = new Set(['refund-a']);
    buzz.getTransactionByExternalId.mockImplementation((async (id: string) =>
      refunds.has(id) ? { transactionId: id } : null) as never);
    buzz.refundTransaction.mockImplementation((async (id: string) => {
      refunds.add(`refund-${id}`);
      return { transactionId: `refund-${id}` };
    }) as never);
    dbMock.dbWrite.userCosmeticShopPurchases.update.mockClear();

    const result = await takedown();

    expect(refundedLegs()).toEqual(['b']);
    expect([result.refunded, result.failures]).toEqual([1, []]);
    expect(dbMock.dbWrite.userCosmeticShopPurchases.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { buzzTransactionId: 'shelf-1' }, data: { refunded: true } })
    );
  });

  // A 409 counts as done only when the leg's refund is on the ledger.
  it('leaves a shelf purchase owed when a leg is refused and its refund is not on the ledger', async () => {
    await seedBox();
    dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockResolvedValue([
      { userId: 104, buzzTransactionId: 'shelf-1', unitAmount: 500, meta: { payouts: [] } },
    ]);
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      { transactionId: 'a', externalTransactionId: 'shelf-1-yellow', accountId: 104, amount: 300 },
      { transactionId: 'b', externalTransactionId: 'shelf-1-blue', accountId: 104, amount: 200 },
    ]);
    buzz.getTransactionByExternalId.mockImplementation((async (id: string) =>
      id === 'refund-a' ? { transactionId: id } : null) as never);
    buzz.refundTransaction.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'conflict', cause: new BuzzApiError(409, 'x') })
    );
    dbMock.dbWrite.userCosmeticShopPurchases.update.mockClear();

    const result = await takedown();

    expect([result.refunded, result.failures]).toEqual([
      0,
      [expect.objectContaining({ stage: 'refund', userId: 104, error: 'conflict' })],
    ]);
    expect(dbMock.dbWrite.userCosmeticShopPurchases.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { buzzTransactionId: 'shelf-1' } })
    );
  });

  // Flagged refunded, a charge Buzz cannot show would never be retried.
  it('leaves a shelf purchase owed when Buzz lists no charge under it', async () => {
    await seedBox();
    dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockResolvedValue([
      { userId: 104, buzzTransactionId: 'shelf-1', unitAmount: 500, meta: { payouts: [] } },
    ]);
    // Calls from earlier tests stay recorded on the shared db mock.
    dbMock.dbWrite.userCosmeticShopPurchases.update.mockClear();

    const result = await takedown();

    expect([result.refunded, result.failures]).toEqual([
      0,
      [
        expect.objectContaining({
          stage: 'refund',
          userId: 104,
          error: 'debits 0 do not match the price 500',
        }),
      ],
    ]);
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.userCosmeticShopPurchases.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { buzzTransactionId: 'shelf-1' } })
    );
  });

  it('does not take back a payout the purchase refund already reversed', async () => {
    const boxId = await seedBox({ sellerId: CREATOR });
    await seedOpening(boxId, {
      meta: {
        payouts: [{ userId: CREATOR, amount: 560, color: 'yellow', transactionId: 'payout-1' }],
      },
    });
    // The payout is keyed under the purchase prefix, so the prefix refund reversed it too.
    buzz.refundMultiAccountTransaction.mockResolvedValue({
      ...refunded800,
      refundedTransactions: [
        ...refunded800.refundedTransactions,
        {
          originalTransactionId: 'payout-1',
          refundTransactionId: 'refund-payout-1',
          accountType: 'yellow',
          amount: 560,
          originalExternalTransactionId: 'e',
        },
      ],
    });

    const result = await takedown();

    expect(buzz.refundTransaction).not.toHaveBeenCalled();
    expect(result.clawedBack).toBe(560);
  });

  // Buzz answering a refund with no legs reversed is not the buyer paid back.
  it('keeps a box refund owed when Buzz reverses nothing under it', async () => {
    const boxId = await seedBox();
    await seedOpening(boxId);
    buzz.refundMultiAccountTransaction.mockResolvedValue({
      ...refunded800,
      refundedTransactions: [],
    });

    const result = await takedown();

    expect([result.boxOpeningsRefunded, result.failures]).toEqual([
      0,
      [expect.objectContaining({ stage: 'refund', userId: BUYER })],
    ]);
  });

  // A single leg answering 409 is counted done by the prefix helper, refund on the ledger or not.
  it('keeps a box refund owed when a leg is still unreversed after finishing it', async () => {
    const boxId = await seedBox();
    const { sourceKey } = await seedOpening(boxId);
    buzz.refundMultiAccountTransaction.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'conflict', cause: new BuzzApiError(409, 'x') })
    );
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      {
        transactionId: 'a',
        externalTransactionId: `${sourceKey}-a`,
        accountType: 'yellow',
        accountId: BUYER,
        amount: 500,
      },
      {
        transactionId: 'b',
        externalTransactionId: `${sourceKey}-b`,
        accountType: 'yellow',
        accountId: BUYER,
        amount: 300,
      },
    ]);
    buzz.getTransactionByExternalId.mockImplementation((async (id: string) =>
      id === 'refund-a' ? { transactionId: id } : null) as never);
    buzz.refundTransaction.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'conflict', cause: new BuzzApiError(409, 'x') })
    );

    const first = await takedown();
    const retried = await takedown();

    expect(first.failures).toEqual([expect.objectContaining({ stage: 'refund', userId: BUYER })]);
    // Still owed, so the retry asks again.
    expect(retried.failures).toEqual([expect.objectContaining({ stage: 'refund', userId: BUYER })]);
  });
});

describe('Retry takedown on an item already taken down', () => {
  const original = { reason: 'Infringing', moderatorId: 7, at: '2026-10-01T00:00:00.000Z' };

  /** Shelf purchases the takedown's own reads and writes keep, as the table would. */
  const shelfTable = (rows: { userId: number; buzzTransactionId: string }[]) => {
    const table = rows.map((row) => ({
      ...row,
      unitAmount: 500,
      meta: { payouts: [] },
      refunded: false,
    }));
    dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockImplementation((async ({
      where,
    }: {
      where: { refunded?: boolean };
    }) =>
      table.filter(
        (row) => where.refunded === undefined || row.refunded === where.refunded
      )) as never);
    dbMock.dbWrite.userCosmeticShopPurchases.update.mockImplementation((async ({
      where,
      data,
    }: {
      where: { buzzTransactionId: string };
      data: { refunded?: boolean };
    }) => {
      const row = table.find((r) => r.buzzTransactionId === where.buzzTransactionId)!;
      if (data.refunded !== undefined) row.refunded = data.refunded;
    }) as never);
  };

  it('pays a failed box refund exactly once, and no shelf buyer already refunded', async () => {
    const boxId = await seedBox();
    const { sourceKey } = await seedOpening(boxId);
    shelfTable([{ userId: 104, buzzTransactionId: 'shelf-1' }]);
    shelfLedger({ 'shelf-1': 104 });
    // The box refund fails; the shelf refund goes through.
    buzz.refundMultiAccountTransaction.mockRejectedValue(new Error('buzz is down'));
    await takedown();
    expect([refundedLegs(), new Set(refundedPrefixes())]).toEqual([
      ['shelf-1-debit'],
      new Set([sourceKey]),
    ]);

    // The retry button, after the first run archived it.
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({ meta: { takedown: original } });
    buzz.refundMultiAccountTransaction.mockReset().mockResolvedValue(refunded800);
    const retry = await takedown();
    const again = await takedown();

    expect([refundedLegs(), refundedPrefixes()]).toEqual([['shelf-1-debit'], [sourceKey]]);
    expect([retry.boxOpeningsRefunded, retry.refunded, again.boxOpeningsRefunded]).toEqual([
      1, 0, 0,
    ]);
  });

  it('keeps the first takedown record, archive date and the rest of the meta, and does not tell the creator again', async () => {
    await seedBox();
    const earlier = { at: '2026-09-01T00:00:00.000Z', userId: 7, kind: 'reviewed', note: 'ok' };
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({
      meta: { takedown: original, history: [earlier], sellerShare: 10 },
    });

    await takedown();

    const { data } = dbMock.dbWrite.cosmeticShopItem.update.mock.calls.at(-1)![0] as {
      data: {
        archivedAt?: Date;
        meta: { takedown: unknown; sellerShare: number; history: { note: string }[] };
      };
    };
    expect(data.meta.takedown).toEqual(original);
    expect(data.archivedAt).toBeUndefined();
    expect(data.meta.sellerShare).toBe(10);
    expect(data.meta.history.map((entry) => entry.note)).toEqual(['ok', 'Retried: Infringing']);
    expect(notifications.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'creator-shop-item-taken-down' })
    );
  });
});
