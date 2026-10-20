import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { creatorBoxWeights } from '@civitai/shared/creator-box-rules';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import { DEFAULT_CREATOR_SHOP_FEES } from '~/server/schema/creator-shop.schema';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The review pane's read of a creator mystery pack, on in-process Postgres with the real mystery box
 * migrations, after the real submit, revise and approve. Buzz, the blocklist and notifications are
 * faked.
 */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const buzz = vi.hoisted(() => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  ...buzz,
}));

const blocklist = vi.hoisted(() => ({ throwOnBlockedUserContent: vi.fn() }));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  ...blocklist,
}));

const notifications = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/notification.service', () => notifications);

type Raw = ReturnType<typeof pgliteRaw>;
const bridge = (db: { query: PGlite['query'] }) => {
  const raw = pgliteRaw(db as PGlite);
  return { $executeRaw: raw.executeRaw, $queryRaw: raw.queryRaw };
};
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
  holder.db.transaction((tx) => fn(bridge(tx)))) as never);

const packs = await import('~/server/services/creator-mystery-pack.service');
const approve = await import('~/server/services/creator-mystery-pack-approve.service');
const review = await import('~/server/services/creator-mystery-pack-review.service');

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

const CREATOR = 10;
const OTHER = 11;
const MOD = 1;

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

/** Items on sale at 500: the creator's are ids 1-8, the other creator's 9-12. */
const seedItems = async () => {
  for (let id = 1; id <= 12; id++) {
    const owner = id <= 8 ? CREATOR : OTHER;
    await q(
      `INSERT INTO "Cosmetic" (id, name, type, data, "createdById") VALUES ($1, $2, 'Badge', '{}', $3)`,
      [id, `Badge ${id}`, owner]
    );
    await q(
      `INSERT INTO "CosmeticShopItem" ("cosmeticId", "unitAmount", title, "addedById", status)
       VALUES ($1, 500, $2, $3, 'Published')`,
      [id, `Badge ${id}`, owner]
    );
  }
};

const submit = async (
  tiers: number[][] = [
    [1, 2, 3, 4],
    [5, 6],
  ],
  price = 500
) =>
  (
    await packs.submitMysteryPack({
      userId: CREATOR,
      countryCode: 'US',
      stickersEnabled: false,
      name: 'My pack',
      description: null,
      buzzType: 'yellow',
      quotedFee: DEFAULT_CREATOR_SHOP_FEES.mysteryPack,
      steepness: 'standard',
      tiers,
      price,
    })
  ).boxId;

const pendingRevisionId = async (boxId: number) =>
  (
    await q<{ id: number }>(
      `SELECT id FROM "BoxRevision" WHERE "boxDefinitionId" = $1 AND status = 'pending'`,
      [boxId]
    )
  )[0]?.id;

const approvePack = async (boxId: number) =>
  approve.reviewMysteryPack({
    boxId,
    reviewerId: MOD,
    action: 'approve',
    stickersEnabled: false,
    revisionId: await pendingRevisionId(boxId),
  });

const listingIdOf = async (boxId: number) =>
  (
    await q<{ id: number }>(`SELECT id FROM "CosmeticShopItem" WHERE "itemDefinitionId" = $1`, [
      boxId,
    ])
  )[0].id;

const read = async (boxId: number) =>
  review.getMysteryPackReview({ listingId: await listingIdOf(boxId), stickersEnabled: false });

const weightsOf = (sizes: number[]) => {
  const layout = creatorBoxWeights(sizes, 'standard');
  if (!layout.ok) throw new Error(layout.reason);
  return layout.weights;
};

beforeAll(async () => {
  holder.db = new PGlite();
  // Stand-ins for the tables the migrations reference, with the columns this code touches.
  await holder.db.exec(`
    CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme', 'CardDecoration');
    CREATE TYPE "CosmeticShopItemStatus" AS ENUM ('Draft', 'PendingReview', 'Published', 'Rejected', 'RequestedChanges', 'Archived');
    CREATE TABLE "User" (id int PRIMARY KEY, muted boolean NOT NULL DEFAULT false, "bannedAt" timestamp, "deletedAt" timestamp);
    CREATE TABLE "Cosmetic" (
      id int PRIMARY KEY, name text NOT NULL, type "CosmeticType" NOT NULL, data jsonb, "createdById" int
    );
    CREATE TABLE "CosmeticShopItem" (
      id serial PRIMARY KEY,
      "cosmeticId" int,
      "unitAmount" int NOT NULL,
      "addedById" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      "availableFrom" timestamp(3),
      "availableTo" timestamp(3),
      "availableQuantity" int,
      meta jsonb NOT NULL DEFAULT '{}',
      title text NOT NULL,
      description text,
      "archivedAt" timestamp(3),
      status "CosmeticShopItemStatus" NOT NULL DEFAULT 'Published',
      "reviewedById" int,
      "reviewedAt" timestamp(3),
      "rejectionReason" text,
      listed boolean NOT NULL DEFAULT true
    );
    CREATE TABLE "UserCosmeticShopPurchases" (
      "buzzTransactionId" text PRIMARY KEY, "userId" int NOT NULL, "shopItemId" int NOT NULL,
      "unitAmount" int NOT NULL, refunded boolean NOT NULL
    );
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(migration);
});

beforeEach(async () => {
  vi.clearAllMocks();
  blocklist.throwOnBlockedUserContent.mockReset().mockResolvedValue(undefined);
  notifications.createNotification.mockReset().mockResolvedValue(undefined);
  buzz.createBuzzTransaction.mockReset().mockResolvedValue({ transactionId: 'fee-tx' });
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  await holder.db.exec(`
    TRUNCATE "BoxRevision", "BoxOddsSnapshot", "BoxContent", "BoxTier", "CosmeticShopItem", "UserCosmeticShopPurchases" RESTART IDENTITY CASCADE;
    DELETE FROM "ItemDefinition";
    DELETE FROM "Cosmetic";
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${CREATOR}), (${OTHER}), (${MOD});
    -- Revision ids apart from box versions, so a read that returns one for the other is caught.
    ALTER SEQUENCE "BoxRevision_id_seq" RESTART WITH 100;
  `);
  await seedItems();
});

const ARCHIVED_PROBLEM = 'Only items approved and live in your shop can go in a mystery pack';

describe('getMysteryPackReview', () => {
  it('shows a first submission checked as approval checks it, with nothing live to compare', async () => {
    const boxId = await submit();
    const result = await read(boxId);

    expect(result.revision?.id).toBe(await pendingRevisionId(boxId));
    expect(result.live).toBeNull();
    expect(result.diff).toBeNull();
    expect(result.proposed).toMatchObject({
      steepness: 'standard',
      price: 500,
      tiers: [
        { key: 'common', name: 'Common', weight: weightsOf([4, 2])[0], count: 4 },
        { key: 'rare', name: 'Rare', weight: weightsOf([4, 2])[1], count: 2 },
      ],
      layoutProblem: null,
      bounds: { min: 500, average: 500, worst: 500, max: 500 },
      priceProblem: null,
    });
    expect(
      result.proposed?.contents.map((c) => [c.tier, c.cosmeticId, c.value, c.problem])
    ).toEqual([
      ['common', 1, 500, null],
      ['common', 2, 500, null],
      ['common', 3, 500, null],
      ['common', 4, 500, null],
      ['rare', 5, 500, null],
      ['rare', 6, 500, null],
    ]);
    expect(result.cosmetics.map((c) => c.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('counts a box-only item at the floor, not its old shelf price', async () => {
    const boxId = await submit();
    await q(
      `UPDATE "CosmeticShopItem" SET listed = false, "unitAmount" = 9000 WHERE "cosmeticId" = 6`
    );
    const result = await read(boxId);
    expect(result.proposed?.contents.find((c) => c.cosmeticId === 6)).toMatchObject({
      listed: false,
      unitAmount: 9000,
      value: 500,
    });
  });

  // The pane shows why approve would fail, where approve itself refuses.
  it('reports a content that stopped qualifying instead of refusing, and approve still refuses it', async () => {
    const boxId = await submit();
    await q(
      `UPDATE "CosmeticShopItem" SET status = 'Archived', "archivedAt" = now() WHERE "cosmeticId" = 6`
    );
    const result = await read(boxId);

    expect(result.proposed?.contents.find((c) => c.cosmeticId === 6)).toMatchObject({
      value: null,
      problem: ARCHIVED_PROBLEM,
    });
    expect(result.proposed?.bounds).toBeNull();
    expect(result.proposed?.priceProblem).toBeNull();
    await expect(approvePack(boxId)).rejects.toThrow(ARCHIVED_PROBLEM);
  });

  it('reports a price the bounds no longer allow', async () => {
    const boxId = await submit();
    await q(`UPDATE "BoxRevision" SET proposal = jsonb_set(proposal, '{price}', '900')`);
    const result = await read(boxId);
    expect(result.proposed?.priceProblem).toBe(
      'The price is at most 500, what the average box gives back'
    );
  });

  it('diffs an edit against the live version it would replace', async () => {
    const boxId = await submit();
    await approvePack(boxId);
    await packs.reviseMysteryPack({
      userId: CREATOR,
      countryCode: 'US',
      stickersEnabled: false,
      boxId,
      steepness: 'standard',
      tiers: [
        [1, 2, 3, 7],
        [5, 4],
      ],
      price: 500,
    });
    const result = await read(boxId);

    expect(result.revision?.id).toBe(await pendingRevisionId(boxId));
    // Submitted at version 1; the approval made version 2.
    expect(result.live).toMatchObject({ version: 2, price: 500 });
    expect(result.diff).toEqual({
      added: [{ tier: 'common', cosmeticId: 7 }],
      removed: [{ tier: 'rare', cosmeticId: 6 }],
      moved: [{ cosmeticId: 4, from: 'common', to: 'rare' }],
      tiers: [],
      price: null,
    });
    // The live side's items are named too, so a removed one has a name.
    expect(result.cosmetics.map((c) => c.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  // A price cut is not a version, so the approval snapshot's price is stale after one.
  it('compares an edit against the price the pack sells at after a cut, not the approved one', async () => {
    await q(`UPDATE "CosmeticShopItem" SET "unitAmount" = 1000 WHERE "cosmeticId" IS NOT NULL`);
    const boxId = await submit(undefined, 900);
    await approvePack(boxId);
    await packs.lowerMysteryPackPrice({ userId: CREATOR, boxId, price: 700 });
    await packs.reviseMysteryPack({
      userId: CREATOR,
      countryCode: 'US',
      stickersEnabled: false,
      boxId,
      steepness: 'standard',
      tiers: [
        [1, 2, 3, 4],
        [5, 6],
      ],
      price: 800,
    });
    const result = await read(boxId);
    expect(result.live?.price).toBe(700);
    expect(result.diff?.price).toEqual({ before: 700, after: 800 });
  });

  it('shows a pack pulled back to review with no edit as its live version alone', async () => {
    const boxId = await submit();
    await approvePack(boxId);
    await approve.reviewMysteryPack({
      boxId,
      reviewerId: MOD,
      action: 'revert',
      rejectionReason: 'Looking again',
      stickersEnabled: false,
    });
    const result = await read(boxId);
    expect(result).toMatchObject({
      listingStatus: 'PendingReview',
      revision: null,
      proposed: null,
      diff: null,
    });
    expect(result.live?.contents).toHaveLength(6);
  });

  it("counts unrefunded sales of the creator's own listing, for items valued over 5,000 only", async () => {
    await q(`UPDATE "CosmeticShopItem" SET "unitAmount" = 6000 WHERE "cosmeticId" IN (5, 6)`);
    await q(`UPDATE "CosmeticShopItem" SET "unitAmount" = 5000 WHERE "cosmeticId" IN (1, 2, 3, 4)`);
    const boxId = await submit(undefined, 5000);
    // Another seller's listing of item 5 is not the creator's price, so its sales don't count.
    await q(
      `INSERT INTO "CosmeticShopItem" ("cosmeticId", "unitAmount", title, "addedById", status)
       VALUES (5, 6000, 'Resale', $1, 'Published')`,
      [OTHER]
    );
    const listingId = async (cosmeticId: number, addedById: number) =>
      (
        await q<{ id: number }>(
          `SELECT id FROM "CosmeticShopItem" WHERE "cosmeticId" = $1 AND "addedById" = $2`,
          [cosmeticId, addedById]
        )
      )[0].id;
    const sale = async (tx: string, shopItemId: number, refunded = false) =>
      q(
        `INSERT INTO "UserCosmeticShopPurchases" ("buzzTransactionId", "userId", "shopItemId", "unitAmount", refunded)
         VALUES ($1, 99, $2, 6000, $3)`,
        [tx, shopItemId, refunded]
      );
    await sale('a', await listingId(5, CREATOR));
    await sale('b', await listingId(5, CREATOR));
    await sale('c', await listingId(5, CREATOR), true);
    await sale('d', await listingId(5, OTHER));
    await sale('e', await listingId(1, CREATOR));

    const result = await read(boxId);
    expect(result.shelfSales.sort((a, b) => a.cosmeticId - b.cosmeticId)).toEqual([
      { cosmeticId: 5, sales: 2 },
      { cosmeticId: 6, sales: 0 },
    ]);
  });

  it("refuses a listing that isn't a creator mystery pack", async () => {
    await expect(
      review.getMysteryPackReview({ listingId: 1, stickersEnabled: false })
    ).rejects.toThrow('Mystery pack not found');
  });
});
