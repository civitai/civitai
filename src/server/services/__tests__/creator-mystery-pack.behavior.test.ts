import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { DEFAULT_CREATOR_SHOP_FEES } from '~/server/schema/creator-shop.schema';
import { COVER_IMAGE_UNAVAILABLE_MESSAGE } from '~/server/services/image-url-ownership';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Creator mystery pack submit, revise and withdraw on in-process Postgres with the real mystery box
 * migrations. Buzz, the blocklist, the region list's KeyValue read and the shop service's Prisma
 * reads are faked; the pack service's SQL is the production SQL.
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

type Raw = ReturnType<typeof pgliteRaw>;
const bridge = (db: { query: PGlite['query'] }) => {
  const raw = pgliteRaw(db as PGlite);
  return {
    $executeRaw: raw.executeRaw,
    $queryRaw: raw.queryRaw,
    // The item edit reads and writes its row through the shared fakes, inside its lock.
    cosmetic: dbMock.dbWrite.cosmetic,
    cosmeticShopItem: dbMock.dbWrite.cosmeticShopItem,
  };
};
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
  holder.db.transaction((tx) => fn(bridge(tx)))) as never);

const packs = await import('~/server/services/creator-mystery-pack.service');
const shop = await import('~/server/services/creator-shop.service');

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
const FEE = DEFAULT_CREATOR_SHOP_FEES.mysteryPack;
const FEE_TX = 'fee-tx';

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

/** Six items on sale at 500 for each creator: the creator's are ids 1-6, the other's 7-12. */
const seedItems = async () => {
  for (let id = 1; id <= 12; id++) {
    const owner = id <= 6 ? CREATOR : OTHER;
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

const submitInput = (overrides: Partial<Parameters<typeof packs.submitMysteryPack>[0]> = {}) => ({
  userId: CREATOR,
  countryCode: 'US',
  stickersEnabled: false,
  name: 'My pack',
  description: null,
  buzzType: 'yellow' as const,
  quotedFee: FEE,
  steepness: 'standard' as const,
  tiers: [
    [1, 2, 3, 4],
    [5, 6],
  ],
  price: 500,
  ...overrides,
});

// Shop artwork is a bare upload key; this one's issue record names the creator.
const ART_KEY = '1a2b3c4d-0000-4000-8000-0000000000bb';
beforeEach(() => {
  redisMock.sysRedis.mGet.mockResolvedValue([String(CREATOR)] as never);
});

const submit = (overrides: Partial<Parameters<typeof packs.submitMysteryPack>[0]> = {}) =>
  packs.submitMysteryPack(submitInput(overrides));

/** A pack that went on sale: its box published at `version`, its listing Published. */
const publish = async (boxId: number, version = 2) => {
  await q(`UPDATE "ItemDefinition" SET status = 'published', version = $2 WHERE id = $1`, [
    boxId,
    version,
  ]);
  await q(`UPDATE "CosmeticShopItem" SET status = 'Published' WHERE "itemDefinitionId" = $1`, [
    boxId,
  ]);
  await q(
    `UPDATE "BoxRevision" SET status = 'approved' WHERE "boxDefinitionId" = $1 AND status = 'pending'`,
    [boxId]
  );
};

const boxRow = async (id: number) =>
  (
    await q<{ type: string; status: string; sellerId: number; version: number }>(
      `SELECT type, status, "sellerId", version FROM "ItemDefinition" WHERE id = $1`,
      [id]
    )
  )[0];
const listingOf = async (boxId: number) =>
  (
    await q<{
      id: number;
      status: string;
      listed: boolean;
      unitAmount: number;
      meta: CosmeticShopItemMeta;
    }>(
      `SELECT id, status::text AS status, listed, "unitAmount", meta FROM "CosmeticShopItem" WHERE "itemDefinitionId" = $1`,
      [boxId]
    )
  )[0];
const revisionsOf = (boxId: number) =>
  q<{ status: string; baseVersion: number; proposal: unknown }>(
    `SELECT status, "baseVersion", proposal FROM "BoxRevision" WHERE "boxDefinitionId" = $1 ORDER BY id`,
    [boxId]
  );

beforeAll(async () => {
  holder.db = new PGlite();
  // Stand-ins for the tables the migrations reference, with the columns this code touches.
  await holder.db.exec(`
    CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme', 'CardDecoration');
    CREATE TYPE "CosmeticShopItemStatus" AS ENUM ('Draft', 'PendingReview', 'Published', 'Rejected', 'RequestedChanges', 'Archived');
    CREATE TABLE "User" (id int PRIMARY KEY, muted boolean NOT NULL DEFAULT false, "bannedAt" timestamp, "deletedAt" timestamp);
    CREATE TABLE "Image" (id serial PRIMARY KEY, "userId" int NOT NULL, url text NOT NULL);
    CREATE TABLE "ShopArtworkKeyOwner" (key text PRIMARY KEY, "userId" int NOT NULL, "recordedAt" timestamp NOT NULL DEFAULT now());
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
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(migration);
});

beforeEach(async () => {
  vi.clearAllMocks();
  for (const fn of Object.values(buzz)) fn.mockReset();
  blocklist.throwOnBlockedUserContent.mockReset().mockResolvedValue(undefined);
  buzz.createBuzzTransaction.mockResolvedValue({ transactionId: FEE_TX });
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  await holder.db.exec(`
    TRUNCATE "BoxRevision", "BoxOddsSnapshot", "BoxContent", "BoxTier", "CosmeticShopItem" RESTART IDENTITY CASCADE;
    DELETE FROM "ItemDefinition";
    DELETE FROM "Cosmetic";
    DELETE FROM "User";
    DELETE FROM "Image";
    INSERT INTO "User" (id) VALUES (${CREATOR}), (${OTHER}), (${MOD});
  `);
  await seedItems();
});

describe('submitting a mystery pack', () => {
  it('writes the box with no tiers or contents, its listing in review, and the proposal; charges the fee once', async () => {
    const { boxId, shopItemId } = await submit();

    expect(await boxRow(boxId)).toEqual({
      type: 'box',
      status: 'draft',
      sellerId: CREATOR,
      version: 1,
    });
    expect(await q(`SELECT 1 FROM "BoxTier" UNION ALL SELECT 1 FROM "BoxContent"`)).toEqual([]);
    const listing = await listingOf(boxId);
    expect(listing).toMatchObject({
      id: shopItemId,
      status: 'PendingReview',
      listed: false,
      unitAmount: 500,
    });
    expect(listing.meta).toMatchObject({ submissionTxId: FEE_TX, submissionFee: FEE });
    expect(listing.meta.history).toEqual([
      expect.objectContaining({ kind: 'submitted', userId: CREATOR, status: 'PendingReview' }),
    ]);
    expect(await revisionsOf(boxId)).toEqual([
      {
        status: 'pending',
        baseVersion: 1,
        proposal: {
          steepness: 'standard',
          tiers: [
            { key: 'common', cosmeticIds: [1, 2, 3, 4] },
            { key: 'rare', cosmeticIds: [5, 6] },
          ],
          price: 500,
        },
      },
    ]);
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: CREATOR, toAccountId: 0, amount: FEE })
    );
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
  });

  it('refunds the fee exactly once and leaves no rows when a write fails', async () => {
    await holder.db.exec(`
      CREATE FUNCTION fail_revision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'revision insert failed'; END $$;
      CREATE TRIGGER fail_revision BEFORE INSERT ON "BoxRevision"
        FOR EACH ROW EXECUTE FUNCTION fail_revision();
    `);
    try {
      await expect(submit()).rejects.toThrow('revision insert failed');
    } finally {
      await holder.db.exec(
        `DROP TRIGGER fail_revision ON "BoxRevision"; DROP FUNCTION fail_revision;`
      );
    }

    expect(buzz.refundTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.refundTransaction).toHaveBeenCalledWith(FEE_TX, expect.any(String));
    expect(await q(`SELECT id FROM "ItemDefinition" WHERE type = 'box'`)).toEqual([]);
    expect(
      await q(`SELECT id FROM "CosmeticShopItem" WHERE "itemDefinitionId" IS NOT NULL`)
    ).toEqual([]);
  });

  it("holds the creator's lock while it writes, keyed by the creator", async () => {
    // Recorded from inside the transaction, where the lock is held.
    await holder.db.exec(`
      CREATE TABLE "SeenLock" (n int);
      CREATE FUNCTION see_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "SeenLock" SELECT count(*) FROM pg_locks
        WHERE locktype = 'advisory' AND classid = x'434d0001'::int::oid AND objid = ${CREATOR} AND objsubid = 2;
        RETURN NEW;
      END $$;
      CREATE TRIGGER see_lock BEFORE INSERT ON "BoxRevision" FOR EACH ROW EXECUTE FUNCTION see_lock();
    `);
    try {
      await submit();
      expect(await q(`SELECT n FROM "SeenLock"`)).toEqual([{ n: 1 }]);
    } finally {
      await holder.db.exec(
        `DROP TRIGGER see_lock ON "BoxRevision"; DROP FUNCTION see_lock; DROP TABLE "SeenLock";`
      );
    }
  });

  it('re-checks the live limit under the lock, and refunds when a pack landed after the charge', async () => {
    for (let i = 0; i < 4; i++) await submit();
    // A fifth pack lands between the pre-charge check and the lock, as a concurrent submit would.
    buzz.createBuzzTransaction.mockImplementationOnce(async () => {
      const [box] = await q<{ id: number }>(
        `INSERT INTO "ItemDefinition" (type, name, status, "sellerId") VALUES ('box', 'Raced', 'draft', $1) RETURNING id`,
        [CREATOR]
      );
      await q(
        `INSERT INTO "CosmeticShopItem" ("itemDefinitionId", "unitAmount", title, "addedById", status, listed)
         VALUES ($1, 500, 'Raced', $2, 'PendingReview', false)`,
        [box.id, CREATOR]
      );
      return { transactionId: 'raced-tx' };
    });

    await expect(submit()).rejects.toThrow('at most 5 mystery packs');
    expect(buzz.refundTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.refundTransaction).toHaveBeenCalledWith('raced-tx', expect.any(String));
    expect(await q(`SELECT id FROM "ItemDefinition" WHERE type = 'box'`)).toHaveLength(5);
  });

  it('runs the name and description through the blocklist', async () => {
    await submit({ description: 'About it' });
    expect(blocklist.throwOnBlockedUserContent).toHaveBeenCalledWith(['My pack', 'About it'], {
      surface: 'creatorShop',
    });
  });

  it('records the rights affirmation with a cover, and refuses a cover without one', async () => {
    await expect(submit({ imageUrl: ART_KEY })).rejects.toThrow(
      'You must confirm you have the rights to sell this artwork'
    );
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();

    const { boxId } = await submit({ imageUrl: ART_KEY, rightsAffirmed: true });
    expect(await q(`SELECT "imageUrl" FROM "ItemDefinition" WHERE id = $1`, [boxId])).toEqual([
      { imageUrl: ART_KEY },
    ]);
    expect((await listingOf(boxId)).meta.rightsAffirmation).toMatchObject({ userId: CREATOR });
  });

  it('accepts stickers only while stickers are on', async () => {
    await q(`UPDATE "Cosmetic" SET type = 'Sticker' WHERE id = 6`);
    await expect(submit()).rejects.toThrow("Badge 6: This kind of item can't go in a mystery pack");
    await expect(submit({ stickersEnabled: true })).resolves.toBeDefined();
  });

  it("judges an item by the creator's live listing when an archived one is newer", async () => {
    await q(
      `INSERT INTO "CosmeticShopItem" ("cosmeticId", "unitAmount", title, "addedById", status, "archivedAt")
       VALUES (6, 500, 'Old', $1, 'Archived', now())`,
      [CREATOR]
    );
    await expect(submit()).resolves.toBeDefined();
  });

  describe('refuses, and charges nothing,', () => {
    it('a fee quote that no longer matches', async () => {
      await expect(submit({ quotedFee: FEE + 1 })).rejects.toThrow('The submission fee changed');
      expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    });

    it('content the blocklist refuses', async () => {
      blocklist.throwOnBlockedUserContent.mockRejectedValueOnce(new Error('blocked'));
      await expect(submit()).rejects.toThrow('blocked');
      expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    });

    it('a price under the floor', async () => {
      await expect(submit({ price: 499 })).rejects.toThrow('The price is at least 500');
      expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    });

    it('items that do not exist', async () => {
      await expect(
        submit({
          tiers: [
            [1, 2, 3, 4],
            [5, 999],
          ],
        })
      ).rejects.toThrow("These items don't exist: 999");
    });

    it.each([
      ['a muted creator', `UPDATE "User" SET muted = true WHERE id = ${CREATOR}`],
      ['a banned creator', `UPDATE "User" SET "bannedAt" = now() WHERE id = ${CREATOR}`],
      ['a deleted creator', `UPDATE "User" SET "deletedAt" = now() WHERE id = ${CREATOR}`],
    ])('%s', async (_label, sql) => {
      await q(sql);
      await expect(submit()).rejects.toThrow("You can't build mystery packs right now");
      expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    });

    it('a creator with an item taken down in the last 90 days, but not 91', async () => {
      const takedownAt = (days: number) =>
        q(
          `INSERT INTO "CosmeticShopItem" ("cosmeticId", "unitAmount", title, "addedById", status, meta)
           VALUES (NULL, 500, 'Gone', $1, 'Archived', $2)`,
          [
            CREATOR,
            {
              takedown: {
                reason: 'x',
                moderatorId: MOD,
                at: new Date(Date.now() - days * 86_400_000).toISOString(),
              },
            },
          ]
        );
      await takedownAt(91);
      await expect(submit()).resolves.toBeDefined();

      await takedownAt(89);
      await expect(submit()).rejects.toThrow('after one of your items is taken down');
      expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    });

    it("but not for another creator's takedown", async () => {
      await q(
        `INSERT INTO "CosmeticShopItem" ("cosmeticId", "unitAmount", title, "addedById", status, meta)
         VALUES (NULL, 500, 'Gone', $1, 'Archived', $2)`,
        [OTHER, { takedown: { reason: 'x', moderatorId: MOD, at: new Date().toISOString() } }]
      );
      await expect(submit()).resolves.toBeDefined();
    });

    it.each([
      ['in a blocked country', 'DE'],
      ['with no known country while any is blocked', null],
    ])('a creator %s', async (_label, countryCode) => {
      dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: ['DE'] } as never);
      await expect(submit({ countryCode })).rejects.toThrow(
        'Mystery packs are not available in your region'
      );
      await expect(submit({ countryCode: 'US' })).resolves.toBeDefined();
      expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    });

    it('a sixth live pack, on sale or in review; sent-back, archived and rejected packs do not count', async () => {
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await submit()).boxId);
      await publish(ids[0]);
      await publish(ids[1]);
      await expect(submit()).rejects.toThrow('at most 5 mystery packs');
      expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(5);

      const setStatus = (id: number, status: string) =>
        q(
          `UPDATE "CosmeticShopItem" SET status = $2::"CosmeticShopItemStatus" WHERE "itemDefinitionId" = $1`,
          [id, status]
        );
      await setStatus(ids[2], 'RequestedChanges');
      await expect(submit()).resolves.toBeDefined();
      await setStatus(ids[3], 'Archived');
      await setStatus(ids[4], 'Rejected');
      await expect(submit()).resolves.toBeDefined();
      await expect(submit()).resolves.toBeDefined();
      await expect(submit()).rejects.toThrow('at most 5 mystery packs');
    });

    it('a sixth live pack, but not counting a box a moderator archived and left on sale', async () => {
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await submit()).boxId);
      await publish(ids[0]);
      await expect(submit()).rejects.toThrow('at most 5 mystery packs');

      await q(`UPDATE "ItemDefinition" SET status = 'archived' WHERE id = $1`, [ids[0]]);
      expect((await listingOf(ids[0])).status).toBe('Published');
      await expect(submit()).resolves.toBeDefined();
    });

    it.each([
      [
        "another creator's item",
        `UPDATE "Cosmetic" SET "createdById" = ${OTHER} WHERE id = 6`,
        'Only items you made can go in your mystery pack',
      ],
      [
        'an event item',
        `UPDATE "Cosmetic" SET data = '{"event":"party"}' WHERE id = 6`,
        "Event items can't go in a mystery pack",
      ],
      [
        'a capped item',
        `UPDATE "CosmeticShopItem" SET "availableQuantity" = 10 WHERE "cosmeticId" = 6`,
        "Items with limited stock or an end date can't go in a mystery pack",
      ],
      [
        'an archived item',
        `UPDATE "CosmeticShopItem" SET "archivedAt" = now() WHERE "cosmeticId" = 6`,
        'Only items approved and live in your shop can go in a mystery pack',
      ],
    ])('%s', async (_label, sql, message) => {
      await q(sql);
      const label = (
        await q(`SELECT 1 FROM "Cosmetic" WHERE id = 6 AND "createdById" = ${CREATOR}`)
      ).length
        ? 'Badge 6'
        : 'Item #6';
      await expect(submit()).rejects.toThrow(`${label}: ${message}`);
      expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    });

    it('a layout whose rarer tier holds more items', async () => {
      await expect(
        submit({
          tiers: [[1], [2, 3, 4, 5, 6]],
        })
      ).rejects.toThrow('Put more items in Common, or fewer in Rare');
      expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    });
  });
});

describe("a pack's value is the creator's own listings", () => {
  it("values contents by the creator's own listing, not another seller's", async () => {
    await q(
      `INSERT INTO "CosmeticShopItem" ("cosmeticId", "unitAmount", title, "addedById", status)
       VALUES (6, 50000, 'Resold', $1, 'Published')`,
      [OTHER]
    );
    await expect(submit({ price: 501 })).rejects.toThrow(
      'The price is at most 500, what the average box gives back'
    );
    await expect(submit({ price: 500 })).resolves.toBeDefined();
  });

  it('caps the price at the average value back', async () => {
    await q(`UPDATE "CosmeticShopItem" SET "unitAmount" = 2000 WHERE "cosmeticId" IN (5, 6)`);
    await expect(submit({ price: 751 })).rejects.toThrow(
      'The price is at most 750, what the average box gives back'
    );
    await expect(submit({ price: 750 })).resolves.toBeDefined();
  });

  it('caps the price at twice the least valuable item', async () => {
    await q(
      `UPDATE "CosmeticShopItem" SET "unitAmount" = 5000 WHERE "cosmeticId" IN (2, 3, 4, 5, 6)`
    );
    await expect(submit({ price: 1001 })).rejects.toThrow(
      'The price is at most 1000, 2 times the least valuable item'
    );
    await expect(submit({ price: 1000 })).resolves.toBeDefined();
  });

  it('counts a box-only item at the floor, whatever its listing says', async () => {
    await q(
      `UPDATE "CosmeticShopItem" SET "unitAmount" = 5000, listed = false WHERE "cosmeticId" IN (5, 6)`
    );
    await expect(submit({ price: 501 })).rejects.toThrow(
      'The price is at most 500, what the average box gives back'
    );
  });
});

describe('revising a mystery pack', () => {
  const revise = (boxId: number, price = 500) =>
    packs.reviseMysteryPack({
      userId: CREATOR,
      countryCode: 'US',
      stickersEnabled: false,
      boxId,
      steepness: 'gentle',
      tiers: [
        [1, 2, 3, 4],
        [5, 6],
      ],
      price,
    });

  it('queues the edit against the live version and leaves the pack on sale', async () => {
    const { boxId } = await submit();
    await publish(boxId, 3);

    await revise(boxId);

    expect(await revisionsOf(boxId)).toEqual([
      expect.objectContaining({ status: 'approved' }),
      expect.objectContaining({
        status: 'pending',
        baseVersion: 3,
        proposal: expect.objectContaining({ steepness: 'gentle' }),
      }),
    ]);
    const listing = await listingOf(boxId);
    expect(listing.status).toBe('Published');
    expect(listing.meta.history.at(-1)).toMatchObject({ kind: 'edited', status: 'Published' });
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1); // the submission only
  });

  it('refuses a second edit while one waits, and the index refuses it too', async () => {
    const { boxId } = await submit();
    await publish(boxId);
    await revise(boxId);

    await expect(revise(boxId)).rejects.toThrow('already has an edit waiting for review');
    await expect(
      q(
        `INSERT INTO "BoxRevision" ("boxDefinitionId", "baseVersion", proposal, "submittedById")
         VALUES ($1, 2, '{}', $2)`,
        [boxId, CREATOR]
      )
    ).rejects.toThrow('BoxRevision_one_pending_key');
  });

  /** A first submission a moderator sent back: not live, with no edit waiting. */
  const sendBack = async (boxId: number) => {
    await q(`UPDATE "BoxRevision" SET status = 'rejected' WHERE "boxDefinitionId" = $1`, [boxId]);
    await q(
      `UPDATE "CosmeticShopItem"
       SET status = 'RequestedChanges', "rejectionReason" = 'Too many', "reviewedById" = $2, "reviewedAt" = now()
       WHERE "itemDefinitionId" = $1`,
      [boxId, MOD]
    );
  };

  it('sends a pack that was sent back before it sold back to review', async () => {
    const { boxId } = await submit();
    await sendBack(boxId);

    await revise(boxId);

    expect((await listingOf(boxId)).status).toBe('PendingReview');
    expect((await revisionsOf(boxId)).at(-1)).toMatchObject({ status: 'pending', baseVersion: 1 });
    // Back in the queue with no verdict, as an item re-entering review is.
    expect(
      await q(
        `SELECT "rejectionReason", "reviewedById", "reviewedAt" FROM "CosmeticShopItem" WHERE "itemDefinitionId" = $1`,
        [boxId]
      )
    ).toEqual([{ rejectionReason: null, reviewedById: null, reviewedAt: null }]);
  });

  it('refuses to send a pack back to review past the live limit', async () => {
    const { boxId } = await submit();
    await sendBack(boxId);
    for (let i = 0; i < 5; i++) await submit();

    await expect(revise(boxId)).rejects.toThrow('at most 5 mystery packs');
    expect((await listingOf(boxId)).status).toBe('RequestedChanges');
  });

  it.each([
    ['a pack waiting for its first review', 'PendingReview', "can't be edited right now"],
    ['a rejected pack', 'Rejected', 'Rejected items are final'],
    ['an archived pack', 'Archived', "can't be edited right now"],
  ])('refuses %s', async (_label, status, message) => {
    const { boxId } = await submit();
    await q(
      `UPDATE "CosmeticShopItem" SET status = $2::"CosmeticShopItemStatus" WHERE "itemDefinitionId" = $1`,
      [boxId, status]
    );
    await expect(revise(boxId)).rejects.toThrow(message);
  });

  it('runs the creator and content checks again', async () => {
    const { boxId } = await submit();
    await publish(boxId);

    await expect(revise(boxId, 501)).rejects.toThrow('The price is at most 500');
    await q(`UPDATE "User" SET muted = true WHERE id = ${CREATOR}`);
    await expect(revise(boxId)).rejects.toThrow("You can't build mystery packs right now");
    expect(await revisionsOf(boxId)).toEqual([expect.objectContaining({ status: 'approved' })]);
  });

  it("treats another creator's pack as not found", async () => {
    const { boxId } = await submit();
    await publish(boxId);
    // With their own items, so the refusal is the box's and not the contents'.
    await expect(
      packs.reviseMysteryPack({
        userId: OTHER,
        countryCode: 'US',
        stickersEnabled: false,
        boxId,
        steepness: 'standard',
        tiers: [
          [7, 8, 9, 10],
          [11, 12],
        ],
        price: 500,
      })
    ).rejects.toThrow('Mystery pack not found');
    await expect(packs.withdrawMysteryPackRevision({ userId: OTHER, boxId })).rejects.toThrow(
      'Mystery pack not found'
    );
  });
});

describe('lowering the price', () => {
  const lower = (boxId: number, price: number, userId = CREATOR) =>
    packs.lowerMysteryPackPrice({ userId, boxId, price });

  /** A pack on sale at 800, with its items' shelf prices raised so that price is in bounds. */
  const onSaleAt800 = async () => {
    await q(`UPDATE "CosmeticShopItem" SET "unitAmount" = 1000 WHERE "cosmeticId" IS NOT NULL`);
    const { boxId } = await submit({ price: 800 });
    await publish(boxId);
    return boxId;
  };

  it('applies at once, with no review and no new version, and records it', async () => {
    const boxId = await onSaleAt800();

    expect(await lower(boxId, 600)).toEqual({ boxId, price: 600 });

    const listing = await listingOf(boxId);
    expect(listing).toMatchObject({ status: 'Published', unitAmount: 600 });
    expect(listing.meta.history.at(-1)).toMatchObject({
      kind: 'edited',
      userId: CREATOR,
      changes: [{ field: 'price', from: 800, to: 600 }],
    });
    expect((await boxRow(boxId)).version).toBe(2);
    expect(await revisionsOf(boxId)).toEqual([expect.objectContaining({ status: 'approved' })]);
  });

  it("holds the creator's lock while it writes, so it can't race an edit", async () => {
    const boxId = await onSaleAt800();
    await holder.db.exec(`
      CREATE TABLE "SeenLock" (n int);
      CREATE FUNCTION see_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "SeenLock" SELECT count(*) FROM pg_locks
        WHERE locktype = 'advisory' AND classid = x'434d0001'::int::oid AND objid = ${CREATOR} AND objsubid = 2;
        RETURN NEW;
      END $$;
      CREATE TRIGGER see_lock BEFORE UPDATE ON "CosmeticShopItem" FOR EACH ROW EXECUTE FUNCTION see_lock();
    `);
    try {
      await lower(boxId, 600);
      expect(await q(`SELECT n FROM "SeenLock"`)).toEqual([{ n: 1 }]);
    } finally {
      await holder.db.exec(
        `DROP TRIGGER see_lock ON "CosmeticShopItem"; DROP FUNCTION see_lock; DROP TABLE "SeenLock";`
      );
    }
  });

  it('refuses a price that is not lower, or under the floor', async () => {
    const boxId = await onSaleAt800();

    await expect(lower(boxId, 800)).rejects.toThrow('The new price must be below 800');
    await expect(lower(boxId, 900)).rejects.toThrow('The new price must be below 800');
    await expect(lower(boxId, 499)).rejects.toThrow('The price is at least 500');
    await expect(lower(boxId, 500)).resolves.toEqual({ boxId, price: 500 });
  });

  it('refuses while an edit waits for review', async () => {
    const boxId = await onSaleAt800();
    await packs.reviseMysteryPack({
      userId: CREATOR,
      countryCode: 'US',
      stickersEnabled: false,
      boxId,
      steepness: 'gentle',
      tiers: [
        [1, 2, 3, 4],
        [5, 6],
      ],
      price: 800,
    });

    await expect(lower(boxId, 600)).rejects.toThrow('has an edit waiting for review');
    expect((await listingOf(boxId)).unitAmount).toBe(800);
  });

  it.each(['PendingReview', 'RequestedChanges', 'Rejected', 'Archived'])(
    'refuses a pack whose listing is %s',
    async (status) => {
      const boxId = await onSaleAt800();
      await q(
        `UPDATE "CosmeticShopItem" SET status = $2::"CosmeticShopItemStatus" WHERE "itemDefinitionId" = $1`,
        [boxId, status]
      );
      await expect(lower(boxId, 600)).rejects.toThrow(
        'Only a mystery pack on sale can be repriced'
      );
    }
  );

  it("treats another creator's pack as not found", async () => {
    const boxId = await onSaleAt800();
    await expect(lower(boxId, 600, OTHER)).rejects.toThrow('Mystery pack not found');
    expect((await listingOf(boxId)).unitAmount).toBe(800);
  });
});

describe('withdrawing', () => {
  it('a pack that never sold archives it and keeps the fee', async () => {
    const { boxId } = await submit();

    expect(await packs.withdrawMysteryPackRevision({ userId: CREATOR, boxId })).toEqual({
      boxId,
      archived: true,
    });

    expect(await revisionsOf(boxId)).toEqual([expect.objectContaining({ status: 'withdrawn' })]);
    expect((await boxRow(boxId)).status).toBe('archived');
    expect((await listingOf(boxId)).status).toBe('Archived');
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
  });

  it('a pack sent back before it sold, with no edit waiting, archives it', async () => {
    const { boxId } = await submit();
    await q(`UPDATE "BoxRevision" SET status = 'rejected' WHERE "boxDefinitionId" = $1`, [boxId]);
    await q(
      `UPDATE "CosmeticShopItem" SET status = 'RequestedChanges' WHERE "itemDefinitionId" = $1`,
      [boxId]
    );

    expect(await packs.withdrawMysteryPackRevision({ userId: CREATOR, boxId })).toEqual({
      boxId,
      archived: true,
    });
    expect((await boxRow(boxId)).status).toBe('archived');
    expect((await listingOf(boxId)).status).toBe('Archived');
  });

  it("a live pack's edit leaves the pack on sale", async () => {
    const { boxId } = await submit();
    await publish(boxId);
    await packs.reviseMysteryPack({
      userId: CREATOR,
      countryCode: 'US',
      stickersEnabled: false,
      boxId,
      steepness: 'gentle',
      tiers: [
        [1, 2, 3, 4],
        [5, 6],
      ],
      price: 500,
    });

    await packs.withdrawMysteryPackRevision({ userId: CREATOR, boxId });

    expect((await revisionsOf(boxId)).at(-1)).toMatchObject({ status: 'withdrawn' });
    expect((await boxRow(boxId)).status).toBe('published');
    expect((await listingOf(boxId)).status).toBe('Published');
  });

  it('refuses when nothing is waiting', async () => {
    const { boxId } = await submit();
    await publish(boxId);
    await expect(packs.withdrawMysteryPackRevision({ userId: CREATOR, boxId })).rejects.toThrow(
      'no edit waiting for review'
    );
  });
});

describe('the creator packs migration', () => {
  it('refuses a seller on anything but a box', async () => {
    await expect(
      q(
        `INSERT INTO "ItemDefinition" (type, name, "cosmeticId", "sellerId") VALUES ('cosmetic', 'x', 1, $1)`,
        [CREATOR]
      )
    ).rejects.toThrow('ItemDefinition_sellerId_box_check');
  });
});

describe('an item in a mystery pack on sale', () => {
  /** Badge 1 as a content of the creator's published pack; returns its shelf listing id. */
  const inLivePack = async ({ enabled = true, status = 'published', platform = false } = {}) => {
    const { boxId } = await submit();
    await publish(boxId);
    await q(`UPDATE "ItemDefinition" SET status = $2 WHERE id = $1`, [boxId, status]);
    if (platform) await q(`UPDATE "ItemDefinition" SET "sellerId" = NULL WHERE id = $1`, [boxId]);
    const [reward] = await q<{ id: number }>(
      `INSERT INTO "ItemDefinition" (type, name, "cosmeticId", status) VALUES ('cosmetic', 'Badge 1', 1, 'published') RETURNING id`
    );
    const [tier] = await q<{ id: number }>(
      `INSERT INTO "BoxTier" ("boxDefinitionId", key, name, weight, "sortOrder") VALUES ($1, 'common', 'Common', 1, 0) RETURNING id`,
      [boxId]
    );
    await q(
      `INSERT INTO "BoxContent" ("boxDefinitionId", "tierId", "rewardDefinitionId", enabled) VALUES ($1, $2, $3, $4)`,
      [boxId, tier.id, reward.id, enabled]
    );
    const [listing] = await q<{ id: number }>(
      `SELECT id FROM "CosmeticShopItem" WHERE "cosmeticId" = 1 AND "addedById" = $1`,
      [CREATOR]
    );
    return listing.id;
  };

  /** What `getOwnedItemOrThrow` reads, for the shelf listing of Badge 1. */
  const ownedItem = (id: number) => ({
    id,
    cosmeticId: 1,
    unitAmount: 500,
    status: 'Published',
    title: 'Badge 1',
    meta: { lastApprovedAmount: 500 },
    addedById: CREATOR,
    rejectionReason: null,
    description: null,
    availableQuantity: null,
    itemDefinitionId: null,
    cosmetic: { id: 1, createdById: CREATOR, type: 'Badge', data: {} },
    _count: { purchases: 0 },
  });

  const refusal = 'This item is in the mystery pack "My pack". Remove it from the pack first.';

  it("can't be archived by its creator", async () => {
    const id = await inLivePack();
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue(ownedItem(id) as never);

    await expect(shop.archiveCreatorShopItem({ userId: CREATOR, id })).rejects.toThrow(refusal);
    expect(dbMock.dbWrite.cosmeticShopItem.update).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled in the pack', { enabled: false }],
    ["in a pack that isn't on sale", { status: 'draft' }],
    ['in a platform box', { platform: true }],
  ])('can be archived when %s', async (_label, state) => {
    const id = await inLivePack(state);
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue(ownedItem(id) as never);

    await shop.archiveCreatorShopItem({ userId: CREATOR, id });
    expect(dbMock.dbWrite.cosmeticShopItem.update).toHaveBeenCalled();
  });

  it("doesn't hold back another seller's listing of the same item", async () => {
    await inLivePack();
    const [resold] = await q<{ id: number }>(
      `INSERT INTO "CosmeticShopItem" ("cosmeticId", "unitAmount", title, "addedById", status)
       VALUES (1, 900, 'Badge 1', $1, 'Published') RETURNING id`,
      [OTHER]
    );
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({
      ...ownedItem(resold.id),
      addedById: OTHER,
    } as never);

    await shop.archiveCreatorShopItem({ userId: OTHER, id: resold.id });
    expect(dbMock.dbWrite.cosmeticShopItem.update).toHaveBeenCalled();
  });

  it("a pack's own listing can't be archived or restored by its creator", async () => {
    const { boxId, shopItemId } = await submit();
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({
      ...ownedItem(shopItemId),
      cosmeticId: null,
      cosmetic: null,
      itemDefinitionId: boxId,
    } as never);

    await expect(shop.archiveCreatorShopItem({ userId: CREATOR, id: shopItemId })).rejects.toThrow(
      'Withdraw a mystery pack instead of archiving its listing'
    );
    await expect(
      shop.unarchiveCreatorShopItem({ userId: CREATOR, id: shopItemId })
    ).rejects.toThrow("A withdrawn mystery pack can't be restored");
    expect(dbMock.dbWrite.cosmeticShopItem.update).not.toHaveBeenCalled();
  });

  it('can be archived by a moderator', async () => {
    const id = await inLivePack();
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue(ownedItem(id) as never);

    await shop.archiveCreatorShopItem({ userId: MOD, isModerator: true, id });
    expect(dbMock.dbWrite.cosmeticShopItem.update).toHaveBeenCalled();
  });

  // Decision: re-listing and a reprice past the review threshold are allowed. Both send the item
  // back to review, but the pack keeps the values it was approved at; the only cost is that the
  // item fails the pack checks at the next edit until it is approved again. Don't restore the
  // refusal without that reason changing.
  it.each([
    [
      'delisted',
      (id: number) => shop.setCreatorShopItemListed({ userId: CREATOR, id, listed: false }),
      { listed: false },
    ],
    [
      're-listed, back to review',
      (id: number) => shop.setCreatorShopItemListed({ userId: CREATOR, id, listed: true }),
      { listed: true, status: 'PendingReview' },
    ],
    [
      'repriced within the threshold, staying on sale',
      (id: number) => shop.updateCreatorShopItem({ userId: CREATOR, id, price: 550 }),
      { status: 'Published' },
    ],
    [
      'repriced past the threshold, back to review',
      (id: number) => shop.updateCreatorShopItem({ userId: CREATOR, id, price: 1000 }),
      { status: 'PendingReview' },
    ],
  ])('can be %s by its creator', async (_label, act, data) => {
    const id = await inLivePack();
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue(ownedItem(id) as never);

    await act(id);
    expect(dbMock.dbWrite.cosmeticShopItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(data) })
    );
  });

  it("can't be capped by its creator", async () => {
    const id = await inLivePack();
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue(ownedItem(id) as never);

    await expect(
      shop.updateCreatorShopItem({ userId: CREATOR, id, availableQuantity: 10 })
    ).rejects.toThrow(refusal);
    expect(dbMock.dbWrite.cosmeticShopItem.update).not.toHaveBeenCalled();
  });
});

describe('submitMysteryPack box image key', () => {
  const KEY = '0a0b0c0d-0000-4000-8000-0000000000aa';
  const boxes = () => q<{ id: number }>(`SELECT id FROM "ItemDefinition"`);

  it("refuses another user's image key before charging", async () => {
    await q(`INSERT INTO "Image" ("userId", url) VALUES ($1, $2)`, [OTHER, KEY]);

    await expect(submit({ imageUrl: KEY, rightsAffirmed: true })).rejects.toThrow(
      COVER_IMAGE_UNAVAILABLE_MESSAGE
    );
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    expect(await boxes()).toEqual([]);
  });

  it('refuses a key issued to another user before charging', async () => {
    redisMock.sysRedis.mGet.mockResolvedValueOnce([String(OTHER)] as never);

    await expect(submit({ imageUrl: KEY, rightsAffirmed: true })).rejects.toThrow(
      COVER_IMAGE_UNAVAILABLE_MESSAGE
    );
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    expect(await boxes()).toEqual([]);
  });

  it("refuses the creator's own image key too", async () => {
    await q(`INSERT INTO "Image" ("userId", url) VALUES ($1, $2)`, [CREATOR, KEY]);

    await expect(submit({ imageUrl: KEY, rightsAffirmed: true })).rejects.toThrow(
      COVER_IMAGE_UNAVAILABLE_MESSAGE
    );
    expect(await boxes()).toEqual([]);
  });

  it('accepts a fresh key once, and refuses it for a second box', async () => {
    redisMock.sysRedis.mGet.mockResolvedValueOnce([String(CREATOR)] as never);
    await submit({ imageUrl: KEY, rightsAffirmed: true });

    await expect(submit({ imageUrl: KEY, rightsAffirmed: true })).rejects.toThrow(
      COVER_IMAGE_UNAVAILABLE_MESSAGE
    );
    expect(await boxes()).toHaveLength(1);
  });
});
