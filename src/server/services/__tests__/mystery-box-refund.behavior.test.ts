import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as ErrorHandling from '~/server/utils/errorHandling';
import type * as MysteryBoxService from '~/server/services/mystery-box.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Box purchase refunds, the unopenable-box job and a whole-box takedown, on in-process Postgres with
 * the real mystery box migrations. Buzz, the revoke, notifications and the pool read (Prisma model
 * calls, which PGlite can't run) are faked; every write is the production SQL.
 */

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  pool: new Map<string, number>(),
  /** What the replica reads instead, where set: a lagging copy. */
  replicaPool: new Map<string, number>(),
  replicaDown: false,
  // Run inside the next transaction, just before its first statement containing `marker`.
  before: null as null | { marker: string; sql: string },
  /** Holder advisory locks taken. */
  locks: 0,
  /** Each pool read the job made: on the replica or not, with the team and catalog it passed. */
  poolReads: [] as { onReplica: boolean; team: string | undefined; catalog: unknown }[],
}));

// Read only: a test fails if the job places a holder in a team.
const teams = vi.hoisted(() => ({
  readEventHolderTeam: vi.fn(),
  getEventBuyerTeam: vi.fn(async () => {
    throw new Error('the over-pool job placed a buyer in a team');
  }),
}));
vi.mock('~/server/events/event-shop-item', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...teams,
}));

const buzz = vi.hoisted(() => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getTransactionByExternalId: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => buzz);
const revoke = vi.hoisted(() => ({ revokeCosmeticsFromUsers: vi.fn() }));
vi.mock('~/server/services/cosmetic.service', () => revoke);
const notifications = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/notification.service', () => notifications);
// The pool is what is left for the holder: a count per (box, user), as `pool` sets it, or as
// `replicaPool` sets it for a read on the replica.
vi.mock('~/server/services/mystery-box.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxService>()),
  getBoxCatalog: async () => [],
  getBoxPoolForUser: async (
    client: unknown,
    p: { boxDefinitionId: number; userId: number; team?: string; catalog?: unknown }
  ) => {
    const key = `${p.boxDefinitionId}:${p.userId}`;
    const onReplica = client === (await import('~/server/db/client')).dbRead;
    holder.poolReads.push({ onReplica, team: p.team, catalog: p.catalog });
    if (onReplica && holder.replicaDown) throw new Error('replica down');
    const size = (onReplica ? holder.replicaPool.get(key) : undefined) ?? holder.pool.get(key) ?? 0;
    return Array.from({ length: size }, () => ({}));
  },
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
      if (strings.join('?').includes('pg_advisory_xact_lock')) holder.locks++;
      const before = holder.before;
      if (before && strings.join('?').includes(before.marker)) {
        holder.before = null;
        await tx.query(before.sql);
      }
      return run(strings, ...values);
    };
  return { $executeRaw: hooked(raw.executeRaw), $queryRaw: hooked(raw.queryRaw) };
};
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
// The replica: the same database, with no lag unless a test fakes one.
dbMock.dbRead.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
  holder.db.transaction((tx) => fn(bridge(tx)))) as never);

const { refundBoxPurchase } = await import('~/server/services/mystery-box-refund.service');
const { refundOverPoolBoxes } = await import('~/server/services/mystery-box-over-pool.service');
const { continueBoxTakedowns, takedownMysteryBox } = await import(
  '~/server/services/mystery-box-takedown.service'
);

const MIGRATIONS = [
  '20261105120000_mystery_box_items',
  '20261107120000_mystery_box_listing_unlisted_and_refunds',
  '20261108120000_creator_mystery_packs',
  '20261231000000_box_opening_guaranteed',
].map((name) =>
  readFileSync(
    join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`),
    'utf8'
  )
);

const MOD = 1;
const SELLER = 10;
const BUYER = 101;
const GRANTEE = 102;
const HAT = 7;
const PRICE = 1000;

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
      listed boolean NOT NULL DEFAULT true, "archivedAt" timestamp,
      "eventTags" text[] NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "CosmeticShopSectionItem" ("shopItemId" int NOT NULL, "shopSectionId" int NOT NULL);
    CREATE TABLE "UserCosmeticShopPurchases" (
      "buzzTransactionId" text PRIMARY KEY, "userId" int NOT NULL, "shopItemId" int NOT NULL,
      "unitAmount" int NOT NULL, refunded boolean NOT NULL, meta jsonb,
      "purchasedAt" timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb NOT NULL);
    INSERT INTO "User" (id) VALUES (${SELLER});
    INSERT INTO "Cosmetic" (id, name, type) VALUES (${HAT}, 'Hat', 'Badge');
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(migration);
  await q(
    `INSERT INTO "ItemDefinition" (type, name, status, "cosmeticId") VALUES ('cosmetic', 'Hat', 'published', ${HAT})`
  );
});

let boxId: number;
let listingId: number;
let nextItem = 1;

const seedBox = async (sellerId: number | null = SELLER) => {
  [{ id: boxId }] = await q<{ id: number }>(
    `INSERT INTO "ItemDefinition" (type, name, status, "sellerId") VALUES ('box', 'Box', 'published', $1) RETURNING id`,
    [sellerId]
  );
  [{ id: listingId }] = await q<{ id: number }>(
    `INSERT INTO "CosmeticShopItem" ("unitAmount", title, "itemDefinitionId", listed)
     VALUES (${PRICE}, 'Pack', $1, false) RETURNING id`,
    [boxId]
  );
};

const buy = async (key: string, { userId = BUYER, meta = null as object | null } = {}) => {
  await q(
    `INSERT INTO "UserCosmeticShopPurchases" ("buzzTransactionId", "userId", "shopItemId", "unitAmount", refunded, meta)
     VALUES ($1, $2, $3, ${PRICE}, false, $4)`,
    [key, userId, listingId, meta && JSON.stringify(meta)]
  );
};

const hold = async (sourceKey: string, userId = BUYER) => {
  const id = nextItem++;
  await q(
    `INSERT INTO "Item" (id, "itemDefinitionId", "holderType", "holderId", "sourceKey", quantity)
     VALUES ($1, $2, 'user', $3, $4, 1)`,
    [id, boxId, userId, sourceKey]
  );
  return id;
};

const open = async (sourceKey: string, userId = BUYER) => {
  const boxItemId = nextItem++;
  await q(
    `INSERT INTO "BoxOpening" ("boxItemId", "boxDefinitionId", "boxVersion", "userId", "boxSourceKey",
       "tierId", "contentId", "rewardDefinitionId", "rewardType", "tierWeight", "eligibleWeight",
       "tierRoll", "tierPoolSize", "itemRoll", "rewardStatus")
     SELECT $1, $2, 1, $3, $4, 0, 0, id, 'cosmetic', 10, 100, 0, 1, 0, 'granted'
     FROM "ItemDefinition" WHERE "cosmeticId" = ${HAT}`,
    [boxItemId, boxId, userId, sourceKey]
  );
  return boxItemId;
};

/** A box sale's ledger: the buyer's debit and, for a creator box, the creator's 70%. */
const ledger = (key: string, { payout = true } = {}) => [
  {
    transactionId: `${key}-debit`,
    externalTransactionId: `${key}-yellow`,
    accountId: BUYER,
    amount: PRICE,
    accountType: 'yellow',
  },
  ...(payout
    ? [
        {
          transactionId: `${key}-payout`,
          externalTransactionId: `${key}:sell:${SELLER}:yellow`,
          accountId: 0,
          amount: 700,
          accountType: 'yellow',
        },
      ]
    : []),
];

const purchaseOf = async (key: string) =>
  (
    await q<{
      refunded: boolean;
      meta: {
        boxRefund: Record<string, unknown>;
        packOverPoolRefunds: Record<string, Record<string, unknown>>;
      } | null;
    }>(`SELECT refunded, meta FROM "UserCosmeticShopPurchases" WHERE "buzzTransactionId" = $1`, [
      key,
    ])
  )[0];
const heldCount = async (userId = BUYER) =>
  (
    await q(`SELECT 1 FROM "Item" WHERE "holderId" = $1 AND "itemDefinitionId" = $2`, [
      userId,
      boxId,
    ])
  ).length;
const reversed = () => buzz.refundTransaction.mock.calls.map(([id]) => id);

beforeEach(async () => {
  await q(`DELETE FROM "BoxOpening"`);
  await q(`DELETE FROM "Item"`);
  await q(`DELETE FROM "UserCosmeticShopPurchases"`);
  await q(`DELETE FROM "KeyValue"`);
  holder.pool.clear();
  holder.replicaPool.clear();
  holder.replicaDown = false;
  holder.before = null;
  holder.locks = 0;
  holder.poolReads = [];
  teams.readEventHolderTeam.mockReset();
  teams.getEventBuyerTeam.mockClear();
  for (const fn of [
    ...Object.values(buzz),
    ...Object.values(revoke),
    ...Object.values(notifications),
  ])
    fn.mockReset();
  buzz.getMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) =>
    ledger(prefix.split('#')[0])
  );
  buzz.getTransactionByExternalId.mockResolvedValue(null);
  buzz.refundTransaction.mockImplementation(async (id: string) => ({
    transactionId: `refund-${id}`,
  }));
  buzz.createBuzzTransaction.mockResolvedValue({ transactionId: 'share-tx' });
  revoke.revokeCosmeticsFromUsers.mockResolvedValue({ revoked: 1 });
  notifications.createNotification.mockResolvedValue(undefined);
  await seedBox();
});

describe('refundBoxPurchase', () => {
  it('takes back a held box, returns the Buzz and reverses the creator’s payout', async () => {
    await buy('p1');
    await hold('p1');

    const outcome = await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'moderator',
      actorId: MOD,
    });

    expect(outcome).toMatchObject({ status: 'refunded', refunded: PRICE, clawedBack: 700 });
    expect(reversed()).toEqual(['p1-debit', 'p1-payout']);
    expect(await heldCount()).toBe(0);
    const purchase = await purchaseOf('p1');
    expect(purchase.refunded).toBe(true);
    expect(purchase.meta?.boxRefund).toMatchObject({
      reason: 'moderator',
      by: MOD,
      paidAt: expect.any(String),
    });
  });

  it('refunds only the buyer for a platform box, which paid nobody', async () => {
    await seedBox(null);
    await buy('p1');
    await hold('p1');
    buzz.getMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) =>
      ledger(prefix, { payout: false })
    );

    const outcome = await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'moderator',
      actorId: MOD,
    });

    expect(outcome).toMatchObject({ status: 'refunded', clawedBack: 0 });
    expect(reversed()).toEqual(['p1-debit']);
  });

  it('takes back what an opened box gave: the opening refunded and its reward revoked', async () => {
    await buy('p1');
    const boxItemId = await open('p1');

    await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'moderator',
      actorId: MOD,
    });

    const [{ rewardStatus }] = await q<{ rewardStatus: string }>(
      `SELECT "rewardStatus" FROM "BoxOpening"`
    );
    expect(rewardStatus).toBe('refunded');
    expect(revoke.revokeCosmeticsFromUsers).toHaveBeenCalledWith({
      userIds: [BUYER],
      cosmeticIds: [HAT],
      claimKeys: [`box-open-${boxItemId}`],
    });
  });

  it('leaves a purchase another refund already took alone', async () => {
    await buy('p1');
    await q(
      `UPDATE "UserCosmeticShopPurchases" SET refunded = true, meta = '{"takedownRefund":{}}'`
    );

    const outcome = await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'moderator',
      actorId: MOD,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'already refunded' });
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
  });

  // Another refund flipping it after this one read it, as the takedown's claim would under the lock.
  it('leaves a purchase another refund flipped after this one read it alone', async () => {
    await buy('p1');
    await hold('p1');
    holder.before = {
      marker: 'UPDATE "UserCosmeticShopPurchases" p',
      sql: `UPDATE "UserCosmeticShopPurchases" SET refunded = true WHERE "buzzTransactionId" = 'p1'`,
    };

    const outcome = await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'moderator',
      actorId: MOD,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'already refunded' });
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
    expect(await heldCount()).toBe(1);
  });

  it('keeps a refund whose Buzz did not come back owed, and finishes it when run again', async () => {
    await buy('p1');
    await hold('p1');
    buzz.refundTransaction.mockRejectedValue(new Error('buzz down'));

    const first = await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'moderator',
      actorId: MOD,
    });
    expect(first.status).toBe('failed');
    expect((await purchaseOf('p1')).meta?.boxRefund.paidAt).toBeUndefined();
    expect(await heldCount()).toBe(0);

    buzz.refundTransaction.mockImplementation(async (id: string) => ({
      transactionId: `refund-${id}`,
    }));
    const second = await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'moderator',
      actorId: MOD,
    });
    expect(second.status).toBe('refunded');
    expect((await purchaseOf('p1')).meta?.boxRefund.paidAt).toEqual(expect.any(String));
  });

  // A whole-charge reversal would pay the stamped box twice; each box is paid its share instead.
  it('refunds a pack partly paid back box by box share by share, each box once', async () => {
    await buy('p1', {
      meta: { pack: { size: 2, guaranteedTierIds: [1] }, packTakedownRefunds: { '5': {} } },
    });
    await hold('p1#pack-02');
    // The first box's share was paid by the takedown: its id answers as a duplicate.
    buzz.createBuzzTransaction.mockImplementation(
      async (input: { externalTransactionId: string }) => {
        if (input.externalTransactionId === 'takedown-pack-share:p1#pack-01')
          throw new TRPCError({ code: 'BAD_REQUEST', cause: new BuzzApiError(409, 'dup') });
        return { transactionId: 'share-tx' };
      }
    );

    const outcome = await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'box-takedown',
      actorId: MOD,
    });

    expect(outcome).toMatchObject({ status: 'refunded', refunded: PRICE, clawedBack: 0 });
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
    expect(buzz.createBuzzTransaction.mock.calls.map(([t]) => t.externalTransactionId)).toEqual([
      'takedown-pack-share:p1#pack-01',
      'takedown-pack-share:p1#pack-02',
    ]);
    expect(await heldCount()).toBe(0);
    expect((await purchaseOf('p1')).meta?.boxRefund.paidAt).toEqual(expect.any(String));
  });

  it('takes nothing back from a buyer whose charge it could not reverse', async () => {
    await buy('p1');
    await hold('p1');
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([]);

    const outcome = await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'moderator',
      actorId: MOD,
    });

    expect(outcome.status).toBe('failed');
    expect(await heldCount()).toBe(1);
    expect((await purchaseOf('p1')).refunded).toBe(false);
  });

  it('takes nothing back from a partly refunded pack whose shares it could not pay', async () => {
    await buy('p1', {
      meta: { pack: { size: 2, guaranteedTierIds: [1] }, packOverPoolRefunds: { 9: { at: 'x' } } },
    });
    await hold('p1#pack-02');
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      { transactionId: 'a', accountId: BUYER, amount: 500, accountType: 'yellow' },
      { transactionId: 'b', accountId: BUYER, amount: 500, accountType: 'green' },
    ]);

    const outcome = await refundBoxPurchase({
      buzzTransactionId: 'p1',
      userId: BUYER,
      reason: 'moderator',
      actorId: MOD,
    });

    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringContaining('by hand') });
    expect(await heldCount()).toBe(1);
    expect((await purchaseOf('p1')).refunded).toBe(false);
  });
});

describe('refundOverPoolBoxes', () => {
  it('refunds the boxes a holder holds beyond what is left for them, newest first', async () => {
    await buy('old');
    await buy('new');
    await hold('old');
    await hold('new');
    holder.pool.set(`${boxId}:${BUYER}`, 1);

    const result = await refundOverPoolBoxes();

    expect(result).toMatchObject({ refunded: 1, failed: [] });
    expect((await purchaseOf('new')).refunded).toBe(true);
    expect((await purchaseOf('old')).refunded).toBe(false);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mystery-box-refunded-unopenable', userId: BUYER })
    );
  });

  it('refunds nothing while every held box can still open (control)', async () => {
    await buy('p1');
    await hold('p1');
    holder.pool.set(`${boxId}:${BUYER}`, 1);

    const result = await refundOverPoolBoxes();

    expect(result.refunded).toBe(0);
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
    // A holding with nothing over its pool is passed on the unlocked read: no holder lock taken.
    expect(holder.locks).toBe(0);
  });

  it('refunds nothing when only a lagging replica says the holder is over the pool', async () => {
    await buy('p1');
    await hold('p1');
    holder.pool.set(`${boxId}:${BUYER}`, 1);
    holder.replicaPool.set(`${boxId}:${BUYER}`, 0);

    const result = await refundOverPoolBoxes();

    expect(result.refunded).toBe(0);
    expect((await purchaseOf('p1')).refunded).toBe(false);
  });

  it('decides on the locked read when the replica cannot be read', async () => {
    await buy('p1');
    await hold('p1');
    holder.replicaDown = true;

    const result = await refundOverPoolBoxes();

    expect(result).toMatchObject({ refunded: 1, failed: [] });
  });

  it("reads an event box's pool for the holder's team, placing no one", async () => {
    await q(`UPDATE "ItemDefinition" SET params = '{"event":"Ev"}' WHERE id = $1`, [boxId]);
    await buy('p1');
    await hold('p1');
    teams.readEventHolderTeam.mockResolvedValue('Pink');

    await refundOverPoolBoxes();

    expect(teams.readEventHolderTeam).toHaveBeenCalledWith('Ev', BUYER);
    expect(teams.getEventBuyerTeam).not.toHaveBeenCalled();
    // The replica read gets the run's catalog; the locked read reads its own.
    expect(holder.poolReads).toEqual([
      { onReplica: true, team: 'Pink', catalog: [] },
      { onReplica: false, team: 'Pink', catalog: undefined },
    ]);
  });

  it('refunds nothing for a box opened after the job chose it', async () => {
    await buy('p1');
    await hold('p1');
    // The holder opens it between the job's choice and its claim.
    holder.before = {
      marker: 'SELECT id FROM "Item"',
      sql: `DELETE FROM "Item" WHERE "sourceKey" = 'p1'`,
    };
    const opened = await open('p1');

    const result = await refundOverPoolBoxes();

    expect(result).toMatchObject({ refunded: 0, failed: [] });
    expect((await purchaseOf('p1')).refunded).toBe(false);
    expect(
      await q(`SELECT "rewardStatus" FROM "BoxOpening" WHERE "boxItemId" = $1`, [opened])
    ).toEqual([{ rewardStatus: 'granted' }]);
    expect(revoke.revokeCosmeticsFromUsers).not.toHaveBeenCalled();
  });

  it('leaves a pack box held when its share could not be paid back', async () => {
    await buy('p1', { meta: { pack: { size: 2, guaranteedTierIds: [1] } } });
    await hold('p1#pack-01');
    await hold('p1#pack-02');
    holder.pool.set(`${boxId}:${BUYER}`, 1);
    // A charge split across accounts has no one account to pay a share back into.
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      { transactionId: 'a', accountId: BUYER, amount: 500, accountType: 'yellow' },
      { transactionId: 'b', accountId: BUYER, amount: 500, accountType: 'green' },
    ]);

    const result = await refundOverPoolBoxes();

    expect(result.failed).toEqual([
      expect.objectContaining({
        userId: BUYER,
        error: expect.stringContaining('refund it by hand'),
      }),
    ]);
    expect(await heldCount()).toBe(2);
    expect((await purchaseOf('p1')).meta).not.toHaveProperty('packOverPoolRefunds');
  });

  it('refunds the purchased box when a newer granted box sits on top of it', async () => {
    await buy('bought');
    await hold('bought');
    await hold('mod-grant-1-101-1');
    holder.pool.set(`${boxId}:${BUYER}`, 1);

    const result = await refundOverPoolBoxes();

    expect(result.refunded).toBe(1);
    expect((await purchaseOf('bought')).refunded).toBe(true);
  });

  it('checks every holding, past the first page, across boxes', async () => {
    for (const userId of [201, 202, 203]) {
      await buy(`p${userId}`, { userId });
      await hold(`p${userId}`, userId);
    }
    // A second box held by a holder in the middle, so a page order that disagrees with the
    // cursor's skips a holding.
    const [{ id: otherBox }] = await q<{ id: number }>(
      `INSERT INTO "ItemDefinition" (type, name, status) VALUES ('box', 'Other', 'published') RETURNING id`
    );
    await q(
      `INSERT INTO "Item" (id, "itemDefinitionId", "holderType", "holderId", "sourceKey", quantity)
       VALUES ($1, $2, 'user', 202, 'mod-grant-1-202-1', 1)`,
      [nextItem++, otherBox]
    );
    buzz.getMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) =>
      ledger(prefix).map((leg) =>
        leg.accountId === BUYER ? { ...leg, accountId: Number(prefix.slice(1)) } : leg
      )
    );

    const result = await refundOverPoolBoxes({ pageSize: 1 });

    expect(result).toMatchObject({ holdingsChecked: 4, refunded: 3, backlog: false });
  });

  it('starts where the last run stopped, and wraps to the start after the last holding', async () => {
    for (const userId of [201, 202, 203]) {
      await buy(`p${userId}`, { userId });
      await hold(`p${userId}`, userId);
    }
    buzz.getMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) =>
      ledger(prefix).map((leg) =>
        leg.accountId === BUYER ? { ...leg, accountId: Number(prefix.slice(1)) } : leg
      )
    );
    await q(
      `INSERT INTO "KeyValue" (key, value) VALUES ('mystery-box-over-pool-scan-cursor', $1)`,
      [JSON.stringify({ boxDefinitionId: boxId, userId: 201 })]
    );

    const first = await refundOverPoolBoxes({ pageSize: 1 });

    expect(first).toMatchObject({ holdingsChecked: 2, refunded: 2 });
    expect((await purchaseOf('p201')).refunded).toBe(false);

    const second = await refundOverPoolBoxes({ pageSize: 1 });

    expect(second.refunded).toBe(1);
    expect((await purchaseOf('p201')).refunded).toBe(true);
  });

  it('finishes a refund a run claimed and could not pay, and only then tells the buyer', async () => {
    await buy('p1');
    await hold('p1');
    buzz.refundTransaction.mockRejectedValue(new Error('buzz down'));

    const first = await refundOverPoolBoxes();
    expect(first.refunded).toBe(0);
    expect(first.failed).not.toHaveLength(0);
    expect(notifications.createNotification).not.toHaveBeenCalled();

    buzz.refundTransaction.mockImplementation(async (id: string) => ({
      transactionId: `refund-${id}`,
    }));
    const second = await refundOverPoolBoxes();

    expect(second.finished).toBe(1);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mystery-box-refunded-unopenable', userId: BUYER })
    );
  });

  it('leaves a moderator’s granted box held: nothing was paid for it', async () => {
    await hold('mod-grant-1-102-1', GRANTEE);

    const result = await refundOverPoolBoxes();

    expect(result.refunded).toBe(0);
    expect(await heldCount(GRANTEE)).toBe(1);
  });

  it('pays a pack box its share, once, and stamps it paid', async () => {
    await buy('p1', { meta: { pack: { size: 2, guaranteedTierIds: [1] } } });
    await hold('p1#pack-01');
    const second = await hold('p1#pack-02');
    holder.pool.set(`${boxId}:${BUYER}`, 1);

    const result = await refundOverPoolBoxes();

    expect(result).toMatchObject({ refunded: 0, sharesPaid: 1 });
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.createBuzzTransaction.mock.calls[0][0]).toMatchObject({
      toAccountId: BUYER,
      amount: 500,
      externalTransactionId: 'takedown-pack-share:p1#pack-02',
    });
    const purchase = await purchaseOf('p1');
    expect(purchase.refunded).toBe(false);
    expect(purchase.meta?.packOverPoolRefunds[String(second)].paidAt).toEqual(expect.any(String));

    await refundOverPoolBoxes();
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('takedownMysteryBox', () => {
  it('stops sales and refunds every purchase, opened and unopened, reversing the payouts', async () => {
    await buy('held');
    await hold('held');
    await buy('opened');
    await open('opened');

    const result = await takedownMysteryBox({
      id: listingId,
      reason: 'Infringing',
      moderatorId: MOD,
    });

    expect(result).toMatchObject({
      purchases: 2,
      refunded: 2,
      refundedValue: 2 * PRICE,
      clawedBack: 1400,
      failed: [],
    });
    const [box] = await q<{ status: string }>(`SELECT status FROM "ItemDefinition" WHERE id = $1`, [
      boxId,
    ]);
    expect(box.status).toBe('archived');
    const [listing] = await q<{ status: string; meta: { takedown: object } }>(
      `SELECT status, meta FROM "CosmeticShopItem" WHERE id = $1`,
      [listingId]
    );
    expect(listing.status).toBe('Archived');
    expect(listing.meta.takedown).toMatchObject({ reason: 'Infringing', moderatorId: MOD });
    expect(reversed().sort()).toEqual([
      'held-debit',
      'held-payout',
      'opened-debit',
      'opened-payout',
    ]);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'creator-shop-item-taken-down', userId: SELLER })
    );
  });

  it('takes back granted boxes with no money and tells their holders so', async () => {
    await hold('mod-grant-1-102-1', GRANTEE);

    const result = await takedownMysteryBox({
      id: listingId,
      reason: 'Infringing',
      moderatorId: MOD,
    });

    expect(result.grantsTakenBack).toBe(1);
    expect(await heldCount(GRANTEE)).toBe(0);
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cosmetic-shop-item-removed', userId: GRANTEE })
    );
  });

  it('tells each refunded buyer, and lists a refund it could not finish', async () => {
    await buy('ok');
    await hold('ok');
    await buy('stuck', { userId: GRANTEE });
    await hold('stuck', GRANTEE);
    buzz.getMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) =>
      prefix === 'stuck' ? [] : ledger(prefix)
    );

    const result = await takedownMysteryBox({
      id: listingId,
      reason: 'Infringing',
      moderatorId: MOD,
    });

    expect(result.failed).toEqual([expect.objectContaining({ buzzTransactionId: 'stuck' })]);
    const told = notifications.createNotification.mock.calls.map(([n]) => [n.type, n.userId]);
    expect(told).toContainEqual(['cosmetic-shop-item-taken-down', BUYER]);
    expect(told).not.toContainEqual(['cosmetic-shop-item-taken-down', GRANTEE]);
  });

  it('revokes what an opened granted box gave', async () => {
    const boxItemId = await open('mod-grant-1-102-1', GRANTEE);

    await takedownMysteryBox({ id: listingId, reason: 'Infringing', moderatorId: MOD });

    expect(revoke.revokeCosmeticsFromUsers).toHaveBeenCalledWith({
      userIds: [GRANTEE],
      cosmeticIds: [HAT],
      claimKeys: [`box-open-${boxItemId}`],
    });
  });

  it('refunds a batch here and leaves the rest to the job, which finishes them', async () => {
    for (const key of ['a', 'b', 'c']) {
      await buy(key);
      await hold(key);
    }

    const first = await takedownMysteryBox({
      id: listingId,
      reason: 'Infringing',
      moderatorId: MOD,
      limit: 1,
    });
    expect(first).toMatchObject({ refunded: 1, more: true });

    const rest = await continueBoxTakedowns(Date.now() + 60_000);
    expect(rest.refunded).toBe(2);
    expect(await heldCount()).toBe(0);
  });

  it('takes back granted boxes after a full batch that refunds the last purchase', async () => {
    await buy('only');
    await hold('only');
    await hold('mod-grant-1-102-1', GRANTEE);

    const result = await takedownMysteryBox({
      id: listingId,
      reason: 'Infringing',
      moderatorId: MOD,
      limit: 1,
    });

    expect(result).toMatchObject({ refunded: 1, more: false, grantsTakenBack: 1 });
    expect(await heldCount(GRANTEE)).toBe(0);
  });

  it('puts a purchase it refused behind the rest, so refusals never stall a box', async () => {
    await buy('bad');
    await hold('bad');
    await buy('good');
    await hold('good');
    buzz.getMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) =>
      prefix === 'bad' ? [] : ledger(prefix)
    );

    const first = await takedownMysteryBox({
      id: listingId,
      reason: 'x',
      moderatorId: MOD,
      limit: 1,
    });
    expect(first).toMatchObject({
      refunded: 0,
      failed: [expect.objectContaining({ buzzTransactionId: 'bad' })],
    });

    const second = await takedownMysteryBox({
      id: listingId,
      reason: 'x',
      moderatorId: MOD,
      limit: 1,
    });
    expect(second.refunded).toBe(1);
    expect((await purchaseOf('good')).refunded).toBe(true);
  });

  it('is continued by the hourly job', async () => {
    for (const key of ['a', 'b']) {
      await buy(key);
      await hold(key);
    }
    await takedownMysteryBox({ id: listingId, reason: 'Infringing', moderatorId: MOD, limit: 1 });

    const run = await refundOverPoolBoxes();

    expect(run.takedowns).toMatchObject({ refunded: 1 });
    expect(await heldCount()).toBe(0);
  });

  it('takes back grants a takedown left out once nothing is owed', async () => {
    // A run that died after its last refund: the box is taken down, nothing is owed, a grant is out.
    await hold('mod-grant-1-102-1', GRANTEE);
    await q(`UPDATE "CosmeticShopItem" SET meta = '{"takedown": {}}' WHERE id = $1`, [listingId]);

    const run = await continueBoxTakedowns(Date.now() + 60_000);

    expect(run).toMatchObject({ boxes: 1, failed: [] });
    expect(await heldCount(GRANTEE)).toBe(0);
  });

  it('takes back grants while full batches of purchases keep failing', async () => {
    for (let n = 0; n < 50; n++) {
      await buy(`stuck-${n}`);
      await hold(`stuck-${n}`);
    }
    await hold('mod-grant-1-102-1', GRANTEE);
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([]);
    await q(`UPDATE "CosmeticShopItem" SET meta = '{"takedown": {}}' WHERE id = $1`, [listingId]);

    const run = await continueBoxTakedowns(Date.now() + 60_000);

    expect(run.refunded).toBe(0);
    expect(await heldCount(GRANTEE)).toBe(0);
  });

  it('lists a box whose takedown run throws, and goes on', async () => {
    await open('mod-grant-1-102-1', GRANTEE);
    await q(`UPDATE "CosmeticShopItem" SET meta = '{"takedown": {}}' WHERE id = $1`, [listingId]);
    revoke.revokeCosmeticsFromUsers.mockRejectedValue(new Error('revoke down'));

    const run = await continueBoxTakedowns(Date.now() + 60_000);

    expect(run.failed).toEqual([{ boxId, error: 'revoke down' }]);
  });

  it('a second run finishes a refund the first claimed and could not pay', async () => {
    await buy('held');
    await hold('held');
    buzz.refundTransaction.mockRejectedValue(new Error('buzz down'));
    await takedownMysteryBox({ id: listingId, reason: 'Infringing', moderatorId: MOD });
    buzz.refundTransaction.mockImplementation(async (id: string) => ({
      transactionId: `refund-${id}`,
    }));

    const again = await takedownMysteryBox({
      id: listingId,
      reason: 'Infringing',
      moderatorId: MOD,
    });

    expect(again).toMatchObject({ purchases: 1, refunded: 1, failed: [] });
    expect((await purchaseOf('held')).meta?.boxRefund.paidAt).toEqual(expect.any(String));
  });

  it('tells the creator once, however often it is run', async () => {
    await takedownMysteryBox({ id: listingId, reason: 'Infringing', moderatorId: MOD });
    await takedownMysteryBox({ id: listingId, reason: 'Infringing', moderatorId: MOD });

    const toCreator = notifications.createNotification.mock.calls.filter(
      ([n]) => n.type === 'creator-shop-item-taken-down'
    );
    expect(toCreator).toHaveLength(1);
  });

  it('refunds nothing twice when run again', async () => {
    await buy('held');
    await hold('held');
    await takedownMysteryBox({ id: listingId, reason: 'Infringing', moderatorId: MOD });
    buzz.refundTransaction.mockClear();

    const again = await takedownMysteryBox({
      id: listingId,
      reason: 'Infringing',
      moderatorId: MOD,
    });

    expect(again.purchases).toBe(0);
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
  });
});
