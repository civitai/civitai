import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stockFor, isSellable } from '@civitai/shared/knights-shop';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../../db', () => ({
  get dbRead() {
    throw new Error('the shop catalog must read from the primary, not the replica');
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

vi.mock('../../mod-activity', () => ({
  withModerators: async <R extends { userId: number | null }>(rows: R[]) =>
    rows.map(({ userId, ...row }) => ({ ...row, moderatorId: userId, moderatorUsername: null })),
}));

const {
  createShopItem,
  listShopChanges,
  listShopItems,
  setShopItemActive,
  stockView,
  updateShopItem,
} = await import('../shop-catalog.service');
const { diffFields, editShopItemSchema, newShopItemSchema } = await import(
  '../shop-catalog.schema'
);

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations'
);

const MOD = 4;
let db: PGlite;

const valid = {
  name: 'Gold pouch',
  price: '500',
  sortOrder: '1',
  rotating: 'on',
};

/** Inserts an item named `name` and returns its serial id. */
async function seedItem(
  name: string,
  o: Partial<{
    kind: string;
    price: number;
    buzz: number | null;
    tier: string | null;
    days: number | null;
    cosmeticId: number | null;
    active: boolean;
    rotating: boolean;
    sortOrder: number;
  }> = {}
) {
  const kind = o.kind ?? 'buzz_pack';
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "KnightsShopItem" ("kind","name","price","buzz","tier","days","cosmeticId","active","rotating","sortOrder")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING "id"`,
    [
      kind,
      name,
      o.price ?? 1000,
      o.buzz === undefined ? (kind === 'buzz_pack' ? 50 : null) : o.buzz,
      o.tier ?? null,
      o.days ?? null,
      o.cosmeticId ?? null,
      o.active ?? true,
      o.rotating ?? false,
      o.sortOrder ?? 0,
    ]
  );
  return rows[0].id;
}

const changes = async () =>
  (
    await db.query<{ itemId: number; userId: number; action: string; changes: unknown }>(
      `SELECT "itemId","userId","action","changes" FROM "KnightsShopItemChange" ORDER BY "id"`
    )
  ).rows;

beforeAll(async () => {
  db = await freshPglite();
  // Stand-ins for the tables the Knights migration references, and for the Cosmetic table the page joins.
  await db.exec(`CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP);
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "name" TEXT, "type" TEXT NOT NULL DEFAULT 'image',
      "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "ingestion" TEXT NOT NULL DEFAULT 'Scanned',
      "blockedFor" TEXT, "needsReview" TEXT, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false, "postId" INTEGER);
    CREATE TABLE "Cosmetic" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "type" TEXT NOT NULL, "data" JSONB,
      "createdById" INTEGER, "flags" INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE "CosmeticShopItem" ("id" INTEGER PRIMARY KEY, "cosmeticId" INTEGER REFERENCES "Cosmetic"("id") ON DELETE CASCADE,
      "addedById" INTEGER, "status" TEXT NOT NULL DEFAULT 'Published', "meta" JSONB NOT NULL DEFAULT '{}', "rejectionReason" TEXT);`);
  await db.exec(
    readFileSync(path.join(MIGRATIONS, '20261210120000_knights_v2_tables', 'migration.sql'), 'utf8')
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(
    `TRUNCATE "KnightsShopItemChange","KnightsShopPurchase","KnightsShopItem","Cosmetic" RESTART IDENTITY CASCADE`
  );
});

describe('newShopItemSchema', () => {
  it.each([
    ['a Buzz pack without Buzz', { kind: 'buzz_pack' }],
    ['a Buzz pack of zero Buzz', { kind: 'buzz_pack', buzz: '0' }],
    ['a cosmetic without a cosmetic', { kind: 'cosmetic' }],
    ['a membership with an unknown tier', { kind: 'membership', tier: 'platinum', days: '7' }],
    ['a membership of zero days', { kind: 'membership', tier: 'gold', days: '0' }],
    ['a membership the shop never sells', { kind: 'membership', tier: 'gold', days: '30' }],
    ['a free item', { kind: 'buzz_pack', buzz: '50', price: '0' }],
    ['an unknown kind', { kind: 'trinket' }],
    ['a rank that does not exist', { kind: 'buzz_pack', buzz: '50', minRank: 'King' }],
  ])('rejects %s', (_label, fields) => {
    expect(newShopItemSchema.safeParse({ ...valid, ...fields }).success).toBe(false);
  });

  it('drops the columns that do not apply to the kind, as the CHECK demands', () => {
    const parsed = newShopItemSchema.parse({
      ...valid,
      kind: 'buzz_pack',
      buzz: '50',
      cosmeticId: '9',
      tier: 'gold',
      minRank: '',
    });
    expect(parsed).toEqual({
      kind: 'buzz_pack',
      name: 'Gold pouch',
      description: '',
      price: 500,
      buzz: 50,
      minRank: null,
      rotating: true,
      sortOrder: 1,
    });
  });
});

describe('diffFields', () => {
  it('lists only the fields whose value differs', () => {
    expect(diffFields({ a: 1, b: 'x', c: null }, { a: 1, b: 'y', c: 2 }, ['a', 'b', 'c'])).toEqual({
      b: { from: 'x', to: 'y' },
      c: { from: null, to: 2 },
    });
    expect(diffFields({ a: 1 }, { a: 1 }, ['a'])).toEqual({});
  });
});

describe('createShopItem', () => {
  it('writes the item under a generated id and one create row with the whole item', async () => {
    const input = newShopItemSchema.parse({
      ...valid,
      kind: 'membership',
      tier: 'gold',
      days: '7',
    });
    const created = await createShopItem(input, MOD);
    expect(created).toEqual({ ok: true, id: expect.any(Number) });
    const id = (created as { id: number }).id;

    const rows = (
      await db.query(
        `SELECT "id","kind","price","tier","days","buzz","active" FROM "KnightsShopItem"`
      )
    ).rows;
    expect(rows).toEqual([
      {
        id,
        kind: 'membership',
        price: 500,
        tier: 'gold',
        days: 7,
        buzz: null,
        active: true,
      },
    ]);
    const [change] = await changes();
    expect(change).toMatchObject({ itemId: id, userId: MOD, action: 'create' });
    expect(change.changes).toMatchObject({
      price: { from: null, to: 500 },
      tier: { from: null, to: 'gold' },
    });
  });

  it('refuses a cosmetic that does not exist', async () => {
    const input = newShopItemSchema.parse({ ...valid, kind: 'cosmetic', cosmeticId: '77' });
    expect(await createShopItem(input, MOD)).toMatchObject({
      ok: false,
      error: expect.stringContaining('cosmetic'),
    });
    expect((await db.query(`SELECT 1 FROM "KnightsShopItem"`)).rows).toEqual([]);
  });

  it('lists the same cosmetic again, for example a retired one back at a new price', async () => {
    await db.query(`INSERT INTO "Cosmetic" ("id","name","type") VALUES (77,'Halo','Badge')`);
    const input = newShopItemSchema.parse({ ...valid, kind: 'cosmetic', cosmeticId: '77' });
    const first = await createShopItem(input, MOD);
    const again = await createShopItem({ ...input, price: 900 }, MOD);

    expect(first).toEqual({ ok: true, id: expect.any(Number) });
    expect(again).toEqual({ ok: true, id: expect.any(Number) });
    expect((again as { id: number }).id).not.toBe((first as { id: number }).id);
    expect((await db.query(`SELECT "price" FROM "KnightsShopItem" ORDER BY "id"`)).rows).toEqual([
      { price: 500 },
      { price: 900 },
    ]);
  });
});

describe('updateShopItem', () => {
  const edit = (id: number, fields: Record<string, string> = {}) =>
    editShopItemSchema.parse({
      id: String(id),
      name: 'buzz-50',
      description: '',
      price: '1000',
      sortOrder: '0',
      ...fields,
    });

  it('writes the new price and a change row holding exactly that difference', async () => {
    const id = await seedItem('buzz-50');
    expect(await updateShopItem(edit(id, { price: '1200' }), MOD)).toEqual({
      ok: true,
      changed: true,
    });

    expect((await db.query(`SELECT "price" FROM "KnightsShopItem"`)).rows).toEqual([
      { price: 1200 },
    ]);
    expect(await changes()).toEqual([
      {
        itemId: id,
        userId: MOD,
        action: 'update',
        changes: { price: { from: 1000, to: 1200 } },
      },
    ]);
  });

  it('writes nothing when nothing differs', async () => {
    const id = await seedItem('buzz-50');
    expect(await updateShopItem(edit(id), MOD)).toEqual({ ok: true, changed: false });
    expect(await changes()).toEqual([]);
  });

  it('refuses an unknown item', async () => {
    expect(await updateShopItem(edit(9999), MOD)).toMatchObject({ ok: false });
  });
});

describe('setShopItemActive', () => {
  it('retires and restores, one change row each, and nothing for a repeat', async () => {
    const id = await seedItem('buzz-50');
    expect(await setShopItemActive(id, false, MOD)).toEqual({ ok: true, changed: true });
    expect(await setShopItemActive(id, false, MOD)).toEqual({ ok: true, changed: false });
    expect(await setShopItemActive(id, true, MOD)).toEqual({ ok: true, changed: true });

    expect(await changes()).toEqual([
      {
        itemId: id,
        userId: MOD,
        action: 'retire',
        changes: { active: { from: true, to: false } },
      },
      {
        itemId: id,
        userId: MOD,
        action: 'restore',
        changes: { active: { from: false, to: true } },
      },
    ]);
  });
});

describe('stockView rotation', () => {
  it('rotates the active, sellable items exactly as the shop does, and reports the rest', async () => {
    for (let i = 0; i < 8; i++) await seedItem(`rot-${i}`, { rotating: true, sortOrder: i });
    const fixed = await seedItem('fixed', { sortOrder: 20 });
    const retired = await seedItem('retired', { active: false });
    const thirtyDays = await seedItem('thirty-days', {
      kind: 'membership',
      buzz: null,
      tier: 'gold',
      days: 30,
    });

    const preview = stockView(await listShopItems(), '2026-12-20');
    const sellable = (
      await db.query<Parameters<typeof stockFor>[0][number]>(
        `SELECT * FROM "KnightsShopItem" WHERE "active"`
      )
    ).rows.filter(isSellable);

    expect(preview.stock.map((s) => [s.item.id, s.price, s.deal])).toEqual(
      stockFor(sellable, '2026-12-20').stock.map((s) => [s.item.id, s.price, s.deal])
    );
    expect(preview.stock.map((s) => s.item.id)).toContain(fixed);
    expect(preview.stock.map((s) => s.item.id)).not.toContain(retired);
    expect(preview.excluded.map((i) => i.id)).toEqual([thirtyDays]);
  });
});

describe('stockView cosmetics', () => {
  it('keeps an item whose cosmetic is missing in its slot but flags it as hidden from players', async () => {
    await db.query(`INSERT INTO "Cosmetic" ("id","name","type") VALUES (1,'Halo','Badge')`);
    const present = await seedItem('present', {
      kind: 'cosmetic',
      buzz: null,
      cosmeticId: 1,
      sortOrder: 1,
    });
    const missing = await seedItem('missing', {
      kind: 'cosmetic',
      buzz: null,
      cosmeticId: 2,
      sortOrder: 2,
    });
    const pack = await seedItem('buzz-50', { sortOrder: 3 });

    const { stock } = stockView(await listShopItems(), '2026-12-20');
    expect(stock.map((s) => [s.item.id, s.hidden])).toEqual([
      [present, null],
      [missing, 'cosmetic missing'],
      [pack, null],
    ]);
  });
});

describe('stockView', () => {
  it('carries each cosmetic along, flags a missing one and holds only the live stock', async () => {
    await db.query(
      `INSERT INTO "Cosmetic" ("id","name","type","data") VALUES (1,'Halo','Badge','{"url":"halo.png"}')`
    );
    for (let i = 0; i < 6; i++) await seedItem(`rot-${i}`, { rotating: true, sortOrder: i });
    await seedItem('halo', { kind: 'cosmetic', buzz: null, cosmeticId: 1, sortOrder: 9 });
    await seedItem('gone', { kind: 'cosmetic', buzz: null, cosmeticId: 2, sortOrder: 10 });
    await seedItem('retired', { active: false });

    const rows = await listShopItems();
    const view = stockView(rows, '2026-12-20');

    const halo = view.stock.find((s) => s.item.name === 'halo');
    expect(halo?.item).toMatchObject({ cosmeticName: 'Halo', cosmeticType: 'Badge' });
    expect(view.stock.find((s) => s.item.name === 'gone')?.hidden).toBe('cosmetic missing');
    expect(view.stock.some((s) => s.item.name === 'retired')).toBe(false);
    expect(view.stock.filter((s) => s.item.rotating)).toHaveLength(4);
    // No daily deals at launch (`DEALS_PER_DAY` is 0): the preview prices everything at its catalog price.
    expect(view.stock.filter((s) => s.deal)).toHaveLength(0);
  });
});

describe('listShopChanges cosmetics', () => {
  it('names the cosmetic of each change from the item row, in the same query', async () => {
    await db.query(`INSERT INTO "Cosmetic" ("id","name","type") VALUES (7,'Gay Pride','Sticker')`);
    const created = await createShopItem(
      { ...newShopItemSchema.parse({ ...valid, kind: 'cosmetic', cosmeticId: '7' }) },
      MOD
    );
    expect(created.ok).toBe(true);
    const { changes } = await listShopChanges({});
    expect(changes[0]).toMatchObject({ cosmeticName: 'Gay Pride', cosmeticType: 'Sticker' });
  });
});

describe('listShopChanges', () => {
  it('pages newest first by id and keeps the item filter across pages', async () => {
    const pack = await seedItem('buzz-50');
    const other = await seedItem('buzz-100');
    for (let i = 0; i < 3; i++) {
      await setShopItemActive(pack, i % 2 === 1, MOD);
    }
    await setShopItemActive(other, false, MOD);

    const first = await listShopChanges({ limit: 3 });
    expect(first.changes).toHaveLength(3);
    expect(first.nextBefore).toBe(first.changes[2].id);

    const second = await listShopChanges({ limit: 3, before: first.nextBefore ?? undefined });
    expect(second.changes).toHaveLength(1);
    expect(second.nextBefore).toBeNull();
    const ids = [...first.changes, ...second.changes].map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(4);

    const filtered = await listShopChanges({ itemId: pack, limit: 2 });
    expect(filtered.changes.every((c) => c.itemId === pack)).toBe(true);
    expect(filtered.nextBefore).toBe(filtered.changes[1].id);
    const rest = await listShopChanges({
      itemId: pack,
      limit: 2,
      before: filtered.nextBefore ?? undefined,
    });
    expect(rest.changes).toHaveLength(1);
    expect(rest.nextBefore).toBeNull();
  });
});

describe('a creator cosmetic that is still in review', () => {
  const seedPending = async () => {
    await db.query(
      `INSERT INTO "Cosmetic" ("id","name","type","createdById") VALUES (9,'Creator badge','Badge',50)`
    );
    await db.query(
      `INSERT INTO "CosmeticShopItem" ("id","cosmeticId","addedById","status") VALUES (1,9,50,'PendingReview')`
    );
  };
  const approve = () => db.query(`UPDATE "CosmeticShopItem" SET "status"='Published' WHERE "id"=1`);
  const asNewItem = () => newShopItemSchema.parse({ ...valid, kind: 'cosmetic', cosmeticId: '9' });

  it('cannot be added to the catalog until it is approved', async () => {
    await seedPending();
    const refused = await createShopItem(asNewItem(), MOD);
    expect(refused).toEqual({ ok: false, error: expect.stringContaining('still in review') });
    expect((await db.query(`SELECT 1 FROM "KnightsShopItem"`)).rows).toHaveLength(0);

    await approve();
    expect(await createShopItem(asNewItem(), MOD)).toMatchObject({ ok: true });
  });

  it('cannot be put back on sale, but can still be retired', async () => {
    await seedPending();
    const id = await seedItem('Creator badge', { kind: 'cosmetic', cosmeticId: 9, active: false });
    expect(await setShopItemActive(id, true, MOD)).toEqual({
      ok: false,
      error: expect.stringContaining('still in review'),
    });

    await approve();
    expect(await setShopItemActive(id, true, MOD)).toEqual({ ok: true, changed: true });
    await db.query(`UPDATE "CosmeticShopItem" SET "status"='PendingReview' WHERE "id"=1`);
    expect(await setShopItemActive(id, false, MOD)).toEqual({ ok: true, changed: true });
  });

  it('is listed as withheld, and the preview leaves it out of the draw like the shop does', async () => {
    await seedPending();
    await seedItem('Creator badge', { kind: 'cosmetic', cosmeticId: 9, rotating: false });
    const rows = await listShopItems();
    expect(rows[0].cosmeticWithheld).toBe(true);
    expect(stockView(rows, '2026-12-20').stock).toEqual([]);

    await approve();
    const after = await listShopItems();
    expect(after[0].cosmeticWithheld).toBe(false);
    expect(stockView(after, '2026-12-20').stock).toHaveLength(1);
  });

  it('takes no rotation slot from approved items', async () => {
    await seedPending();
    // Seeded first so it gets id 1, which wins a slot on this day when it is left in the draw.
    await seedItem('Creator badge', { kind: 'cosmetic', cosmeticId: 9, rotating: true });
    for (let i = 0; i < 4; i++) await seedItem(`Pick ${i}`, { rotating: true });
    const rows = await listShopItems();
    const unfiltered = stockFor(rows.filter(isSellable), '2026-12-20').stock.map(
      ({ item }) => item.name
    );
    expect(unfiltered).toContain('Creator badge');

    const names = stockView(rows, '2026-12-20').stock.map(({ item }) => item.name);
    expect(names.sort()).toEqual(['Pick 0', 'Pick 1', 'Pick 2', 'Pick 3']);
  });
});
