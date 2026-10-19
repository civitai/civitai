import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { creatorBoxWeights } from '@civitai/shared/creator-box-rules';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { DEFAULT_CREATOR_SHOP_FEES } from '~/server/schema/creator-shop.schema';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A moderator's verdicts on a creator mystery pack, and the approve step that applies its pending
 * edit, on in-process Postgres with the real mystery box migrations. Buzz, the blocklist and
 * notifications are faked; the SQL is the production SQL.
 */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite, statements: [] as string[] }));

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
/** Records every statement a transaction runs, in order. */
const bridge = (db: { query: PGlite['query'] }) => {
  const raw = pgliteRaw(db as PGlite);
  const record = (strings: TemplateStringsArray) => holder.statements.push(strings.join('?'));
  return {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings);
      return raw.executeRaw(strings, ...values);
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings);
      return raw.queryRaw(strings, ...values);
    },
  };
};
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
  holder.db.transaction((tx) => fn(bridge(tx)))) as never);

const packs = await import('~/server/services/creator-mystery-pack.service');
const approve = await import('~/server/services/creator-mystery-pack-approve.service');
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

const revise = (boxId: number, tiers: number[][], price = 500) =>
  packs.reviseMysteryPack({
    userId: CREATOR,
    countryCode: 'US',
    stickersEnabled: false,
    boxId,
    steepness: 'standard',
    tiers,
    price,
  });

/** An edit to the same contents at a new price, with the shelf prices raised so it's in bounds. */
const reprice = async (boxId: number, price: number) => {
  await q(`UPDATE "CosmeticShopItem" SET "unitAmount" = 1000 WHERE "cosmeticId" IS NOT NULL`);
  return revise(
    boxId,
    [
      [1, 2, 3, 4],
      [5, 6],
    ],
    price
  );
};

const apply = (boxId: number) =>
  approve.applyBoxRevision({ boxId, moderatorId: MOD, stickersEnabled: false });

const verdict = (
  boxId: number,
  action: 'approve' | 'reject' | 'request-changes' | 'revert',
  rejectionReason?: string
) =>
  approve.reviewMysteryPack({
    boxId,
    reviewerId: MOD,
    action,
    rejectionReason,
    stickersEnabled: false,
  });

const boxRow = async (id: number) =>
  (
    await q<{ status: string; version: number }>(
      `SELECT status, version FROM "ItemDefinition" WHERE id = $1`,
      [id]
    )
  )[0];
const listingOf = async (boxId: number) =>
  (
    await q<{
      status: string;
      unitAmount: number;
      rejectionReason: string | null;
      reviewedById: number | null;
      meta: CosmeticShopItemMeta;
    }>(
      `SELECT status::text AS status, "unitAmount", "rejectionReason", "reviewedById", meta
       FROM "CosmeticShopItem" WHERE "itemDefinitionId" = $1`,
      [boxId]
    )
  )[0];
const revisionsOf = (boxId: number) =>
  q<{
    status: string;
    appliedVersion: number | null;
    reviewedById: number | null;
    note: string | null;
  }>(
    `SELECT status, "appliedVersion", "reviewedById", note FROM "BoxRevision" WHERE "boxDefinitionId" = $1 ORDER BY id`,
    [boxId]
  );
/** Tiers in draw order, each with its cosmetics. */
const contentsOf = async (boxId: number) =>
  q<{ key: string; name: string; weight: number; color: string | null; cosmeticIds: number[] }>(
    `SELECT t.key, t.name, t.weight, t.color,
       coalesce(array_agg(d."cosmeticId" ORDER BY d."cosmeticId") FILTER (WHERE d.id IS NOT NULL), '{}') AS "cosmeticIds"
     FROM "BoxTier" t
     LEFT JOIN "BoxContent" bc ON bc."tierId" = t.id AND bc.enabled
     LEFT JOIN "ItemDefinition" d ON d.id = bc."rewardDefinitionId"
     WHERE t."boxDefinitionId" = $1
     GROUP BY t.id
     ORDER BY t."sortOrder"`,
    [boxId]
  );
const contentIdsByCosmetic = async (boxId: number) =>
  Object.fromEntries(
    (
      await q<{ cosmeticId: number; id: number }>(
        `SELECT d."cosmeticId", bc.id FROM "BoxContent" bc
         JOIN "ItemDefinition" d ON d.id = bc."rewardDefinitionId"
         WHERE bc."boxDefinitionId" = $1`,
        [boxId]
      )
    ).map((row) => [row.cosmeticId, row.id])
  );
const snapshotsOf = (boxId: number) =>
  q<{ version: number; snapshot: unknown; createdById: number }>(
    `SELECT version, snapshot, "createdById" FROM "BoxOddsSnapshot" WHERE "boxDefinitionId" = $1 ORDER BY version`,
    [boxId]
  );

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
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(migration);
});

beforeEach(async () => {
  vi.clearAllMocks();
  for (const fn of Object.values(buzz)) fn.mockReset();
  blocklist.throwOnBlockedUserContent.mockReset().mockResolvedValue(undefined);
  notifications.createNotification.mockReset().mockResolvedValue(undefined);
  buzz.createBuzzTransaction.mockResolvedValue({ transactionId: 'fee-tx' });
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  await holder.db.exec(`
    TRUNCATE "BoxRevision", "BoxOddsSnapshot", "BoxContent", "BoxTier", "CosmeticShopItem" RESTART IDENTITY CASCADE;
    DELETE FROM "ItemDefinition";
    DELETE FROM "Cosmetic";
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${CREATOR}), (${OTHER}), (${MOD});
  `);
  await seedItems();
  holder.statements = [];
});

const weightsOf = (sizes: number[]) => {
  const layout = creatorBoxWeights(sizes, 'standard');
  if (!layout.ok) throw new Error(layout.reason);
  return layout.weights;
};

describe('approving a first submission', () => {
  it('writes the tiers and contents, publishes version 2 with its snapshot, and puts the listing on sale', async () => {
    const boxId = await submit();
    const [common, rare] = weightsOf([4, 2]);

    expect(await apply(boxId)).toMatchObject({ version: 2 });

    expect(await boxRow(boxId)).toEqual({ status: 'published', version: 2 });
    expect(await contentsOf(boxId)).toEqual([
      { key: 'common', name: 'Common', weight: common, color: null, cosmeticIds: [1, 2, 3, 4] },
      { key: 'rare', name: 'Rare', weight: rare, color: null, cosmeticIds: [5, 6] },
    ]);
    expect(await snapshotsOf(boxId)).toEqual([
      {
        version: 2,
        createdById: MOD,
        snapshot: {
          tiers: [
            { key: 'common', name: 'Common', weight: common },
            { key: 'rare', name: 'Rare', weight: rare },
          ],
          contents: [1, 2, 3, 4, 5, 6].map((cosmeticId) => ({
            tier: cosmeticId <= 4 ? 'common' : 'rare',
            cosmeticId,
            value: 500,
          })),
          price: 500,
        },
      },
    ]);
    const listing = await listingOf(boxId);
    expect(listing).toMatchObject({ status: 'Published', unitAmount: 500, reviewedById: MOD });
    expect(listing.meta.lastApprovedAmount).toBe(500);
    expect(listing.meta.history?.at(-1)).toMatchObject({
      kind: 'reviewed',
      action: 'approve',
      status: 'Published',
      userId: MOD,
    });
    expect(await revisionsOf(boxId)).toEqual([
      { status: 'approved', appliedVersion: 2, reviewedById: MOD, note: null },
    ]);
  });

  it("defines each content's cosmetic as a reward, reusing a definition that exists", async () => {
    const [existing] = await q<{ id: number }>(
      `INSERT INTO "ItemDefinition" (type, name, "cosmeticId", status) VALUES ('cosmetic', 'Badge 1', 1, 'published') RETURNING id`
    );
    const boxId = await submit();

    await apply(boxId);

    expect(
      await q(`SELECT count(*)::int AS n FROM "ItemDefinition" WHERE type = 'cosmetic'`)
    ).toEqual([{ n: 6 }]);
    expect(
      await q(
        `SELECT bc."rewardDefinitionId" FROM "BoxContent" bc JOIN "ItemDefinition" d ON d.id = bc."rewardDefinitionId" WHERE d."cosmeticId" = 1`
      )
    ).toEqual([{ rewardDefinitionId: existing.id }]);
  });

  it("values each content at approval, from the creator's listing then, not at submission", async () => {
    const boxId = await submit();
    await q(`UPDATE "CosmeticShopItem" SET "unitAmount" = 900 WHERE "cosmeticId" = 6`);

    await apply(boxId);

    const [{ snapshot }] = await snapshotsOf(boxId);
    expect(
      (snapshot as { contents: { cosmeticId: number; value: number }[] }).contents
    ).toContainEqual({ tier: 'rare', cosmeticId: 6, value: 900 });
  });
});

describe('approving an edit to a pack on sale', () => {
  it('keeps the rows the edit keeps, adds and drops the rest, and bumps the version', async () => {
    const boxId = await submit();
    await apply(boxId);
    const before = await contentIdsByCosmetic(boxId);

    // Item 6 leaves, items 7 and 8 arrive, and a third tier appears.
    await revise(boxId, [[1, 2, 3, 7], [4, 5], [8]]);
    await apply(boxId);

    const [common, rare, legendary] = weightsOf([4, 2, 1]);
    expect(await contentsOf(boxId)).toEqual([
      { key: 'common', name: 'Common', weight: common, color: null, cosmeticIds: [1, 2, 3, 7] },
      { key: 'rare', name: 'Rare', weight: rare, color: null, cosmeticIds: [4, 5] },
      { key: 'legendary', name: 'Legendary', weight: legendary, color: null, cosmeticIds: [8] },
    ]);
    const after = await contentIdsByCosmetic(boxId);
    // A kept content keeps its row (item 4 moved tier); a dropped one is deleted.
    for (const cosmeticId of [1, 2, 3, 4, 5]) expect(after[cosmeticId]).toBe(before[cosmeticId]);
    expect(after[6]).toBeUndefined();
    expect(await boxRow(boxId)).toEqual({ status: 'published', version: 3 });
    expect((await snapshotsOf(boxId)).map((s) => s.version)).toEqual([2, 3]);
    expect((await revisionsOf(boxId)).at(-1)).toMatchObject({
      status: 'approved',
      appliedVersion: 3,
    });
  });

  it('deletes a tier the edit drops', async () => {
    const boxId = await submit([[1, 2, 3], [4, 5], [6]]);
    await apply(boxId);

    await revise(boxId, [
      [1, 2, 3, 4],
      [5, 6],
    ]);
    await apply(boxId);

    expect((await contentsOf(boxId)).map((tier) => tier.key)).toEqual(['common', 'rare']);
  });

  it("sets the listing to the edit's price and keeps it on sale", async () => {
    const boxId = await submit();
    await apply(boxId);

    await reprice(boxId, 800);
    expect((await listingOf(boxId)).status).toBe('Published');
    await apply(boxId);

    expect(await listingOf(boxId)).toMatchObject({ status: 'Published', unitAmount: 800 });
    expect((await listingOf(boxId)).meta.lastApprovedAmount).toBe(800);
  });

  // Decision: every approval is a new version, so the odds page has a snapshot (and a price) for
  // each approved edit. Don't gate the bump on `oddsChanged` without moving the price history.
  it('bumps the version and snapshots the new price even when the odds are unchanged', async () => {
    const boxId = await submit();
    await apply(boxId);

    await reprice(boxId, 800);
    await apply(boxId);

    const snapshots = await snapshotsOf(boxId);
    expect(snapshots.map((s) => [s.version, (s.snapshot as { price: number }).price])).toEqual([
      [2, 500],
      [3, 800],
    ]);
  });
});

describe('approval refuses, and writes nothing,', () => {
  it('an edit made against an older version, which it marks stale', async () => {
    const boxId = await submit();
    await q(`UPDATE "ItemDefinition" SET version = 5 WHERE id = $1`, [boxId]);

    await expect(apply(boxId)).rejects.toThrow('The creator has to edit it again');

    expect(await revisionsOf(boxId)).toEqual([
      expect.objectContaining({ status: 'stale', reviewedById: MOD }),
    ]);
    expect(await boxRow(boxId)).toEqual({ status: 'draft', version: 5 });
    expect(await contentsOf(boxId)).toEqual([]);
    expect((await listingOf(boxId)).status).toBe('PendingReview');
  });

  it.each([
    [
      'a content archived since the edit',
      `UPDATE "CosmeticShopItem" SET "archivedAt" = now() WHERE "cosmeticId" = 6`,
      'Badge 6: Only items approved and live in your shop can go in a mystery pack',
    ],
    [
      'a content back in review since the edit',
      `UPDATE "CosmeticShopItem" SET status = 'PendingReview' WHERE "cosmeticId" = 6`,
      'Badge 6: Only items approved and live in your shop can go in a mystery pack',
    ],
    [
      'a price the contents no longer support',
      `UPDATE "CosmeticShopItem" SET "unitAmount" = 300 WHERE "cosmeticId" = 1`,
      'No price works for this mystery pack',
    ],
  ])('%s, and leaves the edit waiting', async (_label, sql, message) => {
    const boxId = await submit();
    await q(sql);

    await expect(apply(boxId)).rejects.toThrow(message);

    expect(await revisionsOf(boxId)).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(await boxRow(boxId)).toEqual({ status: 'draft', version: 1 });
    expect(await contentsOf(boxId)).toEqual([]);
    expect(await q(`SELECT 1 FROM "ItemDefinition" WHERE type = 'cosmetic'`)).toEqual([]);
  });

  it('a box a moderator archived', async () => {
    const boxId = await submit();
    await apply(boxId);
    await reprice(boxId, 800);
    await q(`UPDATE "ItemDefinition" SET status = 'archived' WHERE id = $1`, [boxId]);

    await expect(apply(boxId)).rejects.toThrow('This mystery pack is archived');
    expect((await revisionsOf(boxId)).at(-1)).toMatchObject({ status: 'pending' });
  });

  it('with no edit waiting', async () => {
    const boxId = await submit();
    await apply(boxId);
    await expect(apply(boxId)).rejects.toThrow('no edit waiting for review');
  });

  it("a platform box, which isn't a mystery pack", async () => {
    const [box] = await q<{ id: number }>(
      `INSERT INTO "ItemDefinition" (type, name, status) VALUES ('box', 'Platform', 'draft') RETURNING id`
    );
    await expect(apply(box.id)).rejects.toThrow('Mystery pack not found');
  });
});

describe('the box row lock', () => {
  // Decision: every open of the box waits on this row until commit, so all prep (the content checks,
  // the reward definitions, reading the rows) runs before it, under the creator's lock only.
  it("is taken after the checks and definitions and before the first box write, under the creator's lock", async () => {
    const boxId = await submit();
    holder.statements = [];

    await apply(boxId);

    const at = (pattern: RegExp) => holder.statements.findIndex((sql) => pattern.test(sql));
    const creatorLock = at(/pg_advisory_xact_lock/);
    const boxLock = at(/FOR NO KEY UPDATE/);
    const contentCheck = at(/FROM "Cosmetic" c\s+LEFT JOIN LATERAL/);
    const define = at(/INSERT INTO "ItemDefinition"/);
    const firstBoxWrite = at(/(INSERT INTO|UPDATE|DELETE FROM) "Box(Tier|Content)"/);
    expect([creatorLock, contentCheck, define, boxLock, firstBoxWrite].every((i) => i >= 0)).toBe(
      true
    );
    expect(creatorLock).toBeLessThan(contentCheck);
    expect(contentCheck).toBeLessThan(boxLock);
    expect(define).toBeLessThan(boxLock);
    expect(boxLock).toBeLessThan(firstBoxWrite);
  });

  /** Runs `sql` inside the approval's transaction, between its prep reads and the box lock. */
  const approveWithChangeBeforeLock = async (boxId: number, sql: string[]) => {
    const original = dbMock.dbWrite.$transaction.getMockImplementation()!;
    dbMock.dbWrite.$transaction.mockImplementationOnce((async (
      fn: (tx: unknown) => Promise<unknown>
    ) =>
      holder.db.transaction(async (tx) => {
        const inner = bridge(tx);
        const queryRaw = inner.$queryRaw;
        inner.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join('?').includes('FOR NO KEY UPDATE'))
            for (const statement of sql) await tx.query(statement, [boxId]);
          return queryRaw(strings, ...values);
        };
        return fn(inner);
      })) as never);
    try {
      return await apply(boxId);
    } finally {
      dbMock.dbWrite.$transaction.mockImplementation(original);
    }
  };

  it('reads the rows again when a save changed them without a new version', async () => {
    const boxId = await submit();
    await apply(boxId);
    await reprice(boxId, 800);

    // A builder save that left the odds alone: item 6's content re-created disabled, the version
    // kept, updatedAt moved.
    await approveWithChangeBeforeLock(boxId, [
      `DELETE FROM "BoxContent" WHERE "boxDefinitionId" = $1 AND "rewardDefinitionId" = (SELECT id FROM "ItemDefinition" WHERE "cosmeticId" = 6)`,
      `INSERT INTO "BoxContent" ("boxDefinitionId", "tierId", "rewardDefinitionId", enabled)
       SELECT $1, t.id, d.id, false FROM "BoxTier" t, "ItemDefinition" d
       WHERE t."boxDefinitionId" = $1 AND t.key = 'rare' AND d."cosmeticId" = 6`,
      `UPDATE "ItemDefinition" SET "updatedAt" = now() + interval '1 second' WHERE id = $1`,
    ]);

    // Planned from the old rows, item 6's new row isn't kept and is deleted.
    expect((await contentsOf(boxId)).find((tier) => tier.key === 'rare')?.cosmeticIds).toEqual([
      5, 6,
    ]);
  });

  it('marks the edit stale when the version moved while it was prepared', async () => {
    const boxId = await submit();
    await apply(boxId);
    await reprice(boxId, 800);

    await expect(
      approveWithChangeBeforeLock(boxId, [
        `UPDATE "ItemDefinition" SET version = version + 1 WHERE id = $1`,
      ])
    ).rejects.toThrow('The creator has to edit it again');

    expect((await revisionsOf(boxId)).at(-1)).toMatchObject({ status: 'stale' });
    expect(await listingOf(boxId)).toMatchObject({ unitAmount: 500 });
    expect(await snapshotsOf(boxId)).toHaveLength(1);
  });
});

describe("a moderator's verdict", () => {
  it('request-changes on a first submission sends it back to its creator with the note', async () => {
    const boxId = await submit();

    await verdict(boxId, 'request-changes', 'Swap item 6');

    expect(await listingOf(boxId)).toMatchObject({
      status: 'RequestedChanges',
      rejectionReason: 'Swap item 6',
      reviewedById: MOD,
    });
    expect(await revisionsOf(boxId)).toEqual([
      expect.objectContaining({ status: 'rejected', note: 'Swap item 6', reviewedById: MOD }),
    ]);
    expect(await boxRow(boxId)).toEqual({ status: 'draft', version: 1 });
    expect((await listingOf(boxId)).meta.history?.at(-1)).toMatchObject({
      kind: 'reviewed',
      action: 'request-changes',
      status: 'RequestedChanges',
      note: 'Swap item 6',
    });
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'creator-shop-item-changes-requested',
        userId: CREATOR,
        details: expect.objectContaining({ reason: 'Swap item 6' }),
      })
    );
  });

  it('reject on a first submission is final: listing rejected, box archived', async () => {
    const boxId = await submit();

    await verdict(boxId, 'reject', 'Not allowed');

    expect((await listingOf(boxId)).status).toBe('Rejected');
    expect((await boxRow(boxId)).status).toBe('archived');
    expect(await revisionsOf(boxId)).toEqual([expect.objectContaining({ status: 'rejected' })]);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'creator-shop-item-rejected', userId: CREATOR })
    );
  });

  it.each(['reject', 'request-changes'] as const)(
    '%s on a live pack turns the edit down and leaves the live version on sale',
    async (action) => {
      const boxId = await submit();
      await apply(boxId);
      await reprice(boxId, 800);

      await verdict(boxId, action, 'No');

      expect(await listingOf(boxId)).toMatchObject({ status: 'Published', unitAmount: 500 });
      expect(await boxRow(boxId)).toEqual({ status: 'published', version: 2 });
      expect((await revisionsOf(boxId)).at(-1)).toMatchObject({ status: 'rejected', note: 'No' });
    }
  );

  it('revert pulls a live pack back to review; approve puts it back on sale at the same version', async () => {
    const boxId = await submit();
    await apply(boxId);

    await verdict(boxId, 'revert', 'Checking a report');
    expect((await listingOf(boxId)).status).toBe('PendingReview');
    expect(await boxRow(boxId)).toEqual({ status: 'published', version: 2 });

    await verdict(boxId, 'approve');
    expect((await listingOf(boxId)).status).toBe('Published');
    expect(await boxRow(boxId)).toEqual({ status: 'published', version: 2 });
    expect(notifications.createNotification.mock.calls.map(([n]) => n.type)).toEqual([
      'creator-shop-item-reverted',
      'creator-shop-item-approved',
    ]);
  });

  it('approve applies the waiting edit and notifies the creator, once per approval', async () => {
    const boxId = await submit();
    await verdict(boxId, 'approve');
    await reprice(boxId, 800);
    await verdict(boxId, 'approve');

    expect(await boxRow(boxId)).toEqual({ status: 'published', version: 3 });
    const keys = notifications.createNotification.mock.calls.map(([n]) => n.key as string);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it.each([
    ['request-changes', 'a live pack with no edit waiting', 'no edit waiting for review'],
    ['revert', 'a pack not on sale', 'Only a mystery pack on sale can be reverted'],
  ] as const)('%s refuses %s', async (action, _label, message) => {
    const boxId = await submit();
    if (action === 'request-changes') await apply(boxId);

    await expect(verdict(boxId, action, 'note')).rejects.toThrow(message);
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('reaches a mystery pack through the review queue, and leaves other listings alone', async () => {
    const boxId = await submit();
    const [{ id: listingId }] = await q<{ id: number }>(
      `SELECT id FROM "CosmeticShopItem" WHERE "itemDefinitionId" = $1`,
      [boxId]
    );
    dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue({
      id: listingId,
      cosmeticId: null,
      unitAmount: 500,
      status: 'PendingReview',
      meta: {},
      title: 'My pack',
      addedById: CREATOR,
      itemDefinition: { id: boxId, sellerId: CREATOR },
      cosmetic: null,
    } as never);

    await shop.reviewCreatorShopItem({
      id: listingId,
      reviewerId: MOD,
      action: 'approve',
      stickersEnabled: false,
    });

    expect(await boxRow(boxId)).toEqual({ status: 'published', version: 2 });
    expect(dbMock.dbWrite.cosmeticShopItem.update).not.toHaveBeenCalled();
  });
});
