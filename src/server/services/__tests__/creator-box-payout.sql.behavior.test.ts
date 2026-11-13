import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/** The payout's meta write and the sweep's selection, as production SQL on in-process Postgres. */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const buzz = vi.hoisted(() => ({
  createBuzzTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  refundTransaction: vi.fn(),
  getTransactionByExternalId: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => buzz);

type Raw = ReturnType<typeof pgliteRaw>;
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);

const { payCreatorBoxSale, sweepCreatorBoxPayouts } = await import(
  '~/server/services/creator-box-payout.service'
);

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

const SELLER = 10;
const BUYER = 101;

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "CosmeticType" AS ENUM ('Badge');
    CREATE TYPE "CosmeticShopItemStatus" AS ENUM ('Draft', 'PendingReview', 'Published', 'Rejected', 'RequestedChanges', 'Archived');
    CREATE TABLE "User" (id int PRIMARY KEY);
    CREATE TABLE "Cosmetic" (
      id int PRIMARY KEY, name text NOT NULL, type "CosmeticType" NOT NULL, data jsonb, "createdById" int
    );
    CREATE TABLE "CosmeticShopItem" (
      id serial PRIMARY KEY, "cosmeticId" int, "unitAmount" int NOT NULL, title text NOT NULL,
      meta jsonb NOT NULL DEFAULT '{}', status "CosmeticShopItemStatus" NOT NULL DEFAULT 'Published',
      listed boolean NOT NULL DEFAULT true
    );
    CREATE TABLE "UserCosmeticShopPurchases" (
      "buzzTransactionId" text PRIMARY KEY, "userId" int NOT NULL, "shopItemId" int NOT NULL,
      "unitAmount" int NOT NULL, refunded boolean NOT NULL, meta jsonb,
      "purchasedAt" timestamp NOT NULL DEFAULT now()
    );
    INSERT INTO "User" (id) VALUES (${SELLER});
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(migration);
});

let listingOf: { creator: number; platform: number };
beforeEach(async () => {
  await q(`DELETE FROM "UserCosmeticShopPurchases"`);
  await q(`DELETE FROM "CosmeticShopItem"`);
  await q(`DELETE FROM "ItemDefinition"`);
  const listing = async (sellerId: number | null) => {
    const [{ id: boxId }] = await q<{ id: number }>(
      `INSERT INTO "ItemDefinition" (type, name, status, "sellerId") VALUES ('box', 'Box', 'published', $1) RETURNING id`,
      [sellerId]
    );
    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO "CosmeticShopItem" ("unitAmount", title, "itemDefinitionId", listed)
       VALUES (1000, 'Pack', $1, false) RETURNING id`,
      [boxId]
    );
    return id;
  };
  listingOf = { creator: await listing(SELLER), platform: await listing(null) };
  buzz.createBuzzTransaction.mockReset().mockResolvedValue({ transactionId: 'payout-tx' });
  buzz.refundTransaction.mockReset().mockResolvedValue({ transactionId: 'refund-payout-tx' });
  buzz.getMultiAccountTransactionsByPrefix
    .mockReset()
    .mockImplementation(async (prefix: string) => [
      {
        transactionId: `${prefix}-d`,
        externalTransactionId: `${prefix}-yellow`,
        accountId: BUYER,
        accountType: 'yellow',
      },
    ]);
});

const purchase = (
  id: string,
  {
    shopItemId = listingOf.creator,
    minutesAgo = 30,
    refunded = false,
    meta = null as object | null,
  } = {}
) =>
  q(
    `INSERT INTO "UserCosmeticShopPurchases"
       ("buzzTransactionId", "userId", "shopItemId", "unitAmount", refunded, meta, "purchasedAt")
     VALUES ($1, $2, $3, 1000, $4, $5, now() - make_interval(mins => $6::int))`,
    [id, BUYER, shopItemId, refunded, meta && JSON.stringify(meta), minutesAgo]
  );

const metaOf = async (id: string) =>
  (
    await q<{ meta: unknown }>(
      `SELECT meta FROM "UserCosmeticShopPurchases" WHERE "buzzTransactionId" = $1`,
      [id]
    )
  )[0].meta;

describe('the payout record', () => {
  it('merges into the purchase meta, keeping what is already there', async () => {
    await purchase('p1', { meta: { other: { kept: true } } });

    await payCreatorBoxSale({
      buzzTransactionId: 'p1',
      buyerId: BUYER,
      sellerId: SELLER,
      unitAmount: 1000,
      color: 'yellow',
      title: 'Pack',
    });

    expect(await metaOf('p1')).toEqual({
      other: { kept: true },
      payouts: [{ userId: SELLER, amount: 700, color: 'yellow', transactionId: 'payout-tx' }],
      platformCut: 300,
    });
  });

  // A refund flips the purchase before it reads meta.payouts: one that ran while this payout was in
  // flight found nothing to reverse, so the payout reverses itself.
  it('reverses a payout that lands on a sale refunded meanwhile, recording nothing', async () => {
    await purchase('p1', { refunded: true });

    const result = await payCreatorBoxSale({
      buzzTransactionId: 'p1',
      buyerId: BUYER,
      sellerId: SELLER,
      unitAmount: 1000,
      color: 'yellow',
      title: 'Pack',
    });

    expect(result).toBe('reversed');
    expect(buzz.refundTransaction).toHaveBeenCalledWith('payout-tx', expect.any(String), undefined);
    expect(await metaOf('p1')).toBeNull();
  });

  it('writes only the sale it paid', async () => {
    await purchase('p1');
    await purchase('p2');

    await payCreatorBoxSale({
      buzzTransactionId: 'p1',
      buyerId: BUYER,
      sellerId: SELLER,
      unitAmount: 1000,
      color: 'yellow',
      title: 'Pack',
    });

    expect(await metaOf('p2')).toBeNull();
  });
});

describe('the sweep', () => {
  it('pays only unrefunded creator-box sales old enough and with no payout recorded', async () => {
    await purchase('owed');
    await purchase('fresh', { minutesAgo: 1 });
    await purchase('refunded', { refunded: true });
    await purchase('paid', { meta: { payouts: [], platformCut: 1000 } });
    await purchase('platform', { shopItemId: listingOf.platform });

    const result = await sweepCreatorBoxPayouts();

    expect(result).toMatchObject({ found: 1, paid: 1, failed: [] });
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.createBuzzTransaction.mock.calls[0][0]).toMatchObject({
      externalTransactionId: `owed:sell:${SELLER}:yellow`,
    });
    expect(await metaOf('owed')).toMatchObject({ payouts: [{ amount: 700 }] });
  });

  it('puts a sale that failed before behind the others, so stuck sales never fill the batch', async () => {
    await purchase('stuck', { minutesAgo: 60, meta: { payoutAttempt: { at: 'x', error: 'e' } } });
    await purchase('owed', { minutesAgo: 30 });

    await sweepCreatorBoxPayouts({ limit: 1 });

    expect(buzz.createBuzzTransaction.mock.calls[0][0]).toMatchObject({
      externalTransactionId: `owed:sell:${SELLER}:yellow`,
    });
  });

  it('stamps a failed sale so the next run orders it last', async () => {
    await purchase('owed');
    buzz.createBuzzTransaction.mockRejectedValue(new Error('buzz down'));

    const result = await sweepCreatorBoxPayouts();

    expect(result.failed).toHaveLength(1);
    expect(await metaOf('owed')).toEqual({
      payoutAttempt: { at: expect.any(String), error: 'buzz down' },
    });
  });
});
