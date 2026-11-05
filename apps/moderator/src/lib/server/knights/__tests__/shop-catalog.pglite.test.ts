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

const { createShopItem, listShopChanges, previewShop, setShopItemActive, updateShopItem } =
  await import('../shop-catalog.service');
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

async function seedItem(
  id: string,
  o: Partial<{
    kind: string;
    price: number;
    buzz: number | null;
    tier: string | null;
    months: number | null;
    cosmeticId: number | null;
    active: boolean;
    rotating: boolean;
    sortOrder: number;
  }> = {}
) {
  const kind = o.kind ?? 'buzz_pack';
  await db.query(
    `INSERT INTO "KnightsShopItem" ("id","kind","name","price","buzz","tier","months","cosmeticId","active","rotating","sortOrder")
     VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      kind,
      o.price ?? 1000,
      o.buzz === undefined ? (kind === 'buzz_pack' ? 50 : null) : o.buzz,
      o.tier ?? null,
      o.months ?? null,
      o.cosmeticId ?? null,
      o.active ?? true,
      o.rotating ?? false,
      o.sortOrder ?? 0,
    ]
  );
}

const changes = async () =>
  (
    await db.query<{ itemId: string; userId: number; action: string; changes: unknown }>(
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
    CREATE TABLE "Cosmetic" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "type" TEXT NOT NULL, "data" JSONB);`);
  for (const dir of [
    '20261210120000_knights_v2_tables',
    '20261213120000_knights_v2_shop_item_change',
  ]) {
    await db.exec(readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }
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
    ['a membership with an unknown tier', { kind: 'membership', tier: 'platinum', months: '1' }],
    ['a membership of zero months', { kind: 'membership', tier: 'gold', months: '0' }],
    ['a membership the shop never sells', { kind: 'membership', tier: 'gold', months: '3' }],
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
  it('writes the item under the seed id scheme and one create row with the whole item', async () => {
    const input = newShopItemSchema.parse({
      ...valid,
      kind: 'membership',
      tier: 'gold',
      months: '1',
    });
    expect(await createShopItem(input, MOD)).toEqual({ ok: true, id: 'membership-gold-1m' });

    const rows = (
      await db.query(
        `SELECT "id","kind","price","tier","months","buzz","active" FROM "KnightsShopItem"`
      )
    ).rows;
    expect(rows).toEqual([
      {
        id: 'membership-gold-1m',
        kind: 'membership',
        price: 500,
        tier: 'gold',
        months: 1,
        buzz: null,
        active: true,
      },
    ]);
    const [change] = await changes();
    expect(change).toMatchObject({ itemId: 'membership-gold-1m', userId: MOD, action: 'create' });
    expect(change.changes).toMatchObject({
      price: { from: null, to: 500 },
      tier: { from: null, to: 'gold' },
    });
  });

  it('refuses an id that is already taken, without a second change row', async () => {
    await seedItem('buzz-50');
    const input = newShopItemSchema.parse({ ...valid, kind: 'buzz_pack', buzz: '50' });
    expect(await createShopItem(input, MOD)).toMatchObject({ ok: false });
    expect(await changes()).toEqual([]);
  });

  it('refuses a cosmetic that does not exist', async () => {
    const input = newShopItemSchema.parse({ ...valid, kind: 'cosmetic', cosmeticId: '77' });
    expect(await createShopItem(input, MOD)).toMatchObject({
      ok: false,
      error: expect.stringContaining('cosmetic'),
    });
    expect((await db.query(`SELECT 1 FROM "KnightsShopItem"`)).rows).toEqual([]);
  });

  it('sells a cosmetic that exists as cosmetic-<id>', async () => {
    await db.query(`INSERT INTO "Cosmetic" ("id","name","type") VALUES (77,'Halo','Badge')`);
    const input = newShopItemSchema.parse({ ...valid, kind: 'cosmetic', cosmeticId: '77' });
    expect(await createShopItem(input, MOD)).toEqual({ ok: true, id: 'cosmetic-77' });
  });
});

describe('updateShopItem', () => {
  const edit = (fields: Record<string, string>) =>
    editShopItemSchema.parse({
      id: 'buzz-50',
      name: 'buzz-50',
      description: '',
      price: '1000',
      sortOrder: '0',
      ...fields,
    });

  it('writes the new price and a change row holding exactly that difference', async () => {
    await seedItem('buzz-50');
    expect(await updateShopItem(edit({ price: '1200' }), MOD)).toEqual({ ok: true, changed: true });

    expect((await db.query(`SELECT "price" FROM "KnightsShopItem"`)).rows).toEqual([
      { price: 1200 },
    ]);
    expect(await changes()).toEqual([
      {
        itemId: 'buzz-50',
        userId: MOD,
        action: 'update',
        changes: { price: { from: 1000, to: 1200 } },
      },
    ]);
  });

  it('writes nothing when nothing differs', async () => {
    await seedItem('buzz-50');
    expect(await updateShopItem(edit({}), MOD)).toEqual({ ok: true, changed: false });
    expect(await changes()).toEqual([]);
  });

  it('refuses an unknown item', async () => {
    expect(await updateShopItem(edit({ id: 'nope' }), MOD)).toMatchObject({ ok: false });
  });
});

describe('setShopItemActive', () => {
  it('retires and restores, one change row each, and nothing for a repeat', async () => {
    await seedItem('buzz-50');
    expect(await setShopItemActive('buzz-50', false, MOD)).toEqual({ ok: true, changed: true });
    expect(await setShopItemActive('buzz-50', false, MOD)).toEqual({ ok: true, changed: false });
    expect(await setShopItemActive('buzz-50', true, MOD)).toEqual({ ok: true, changed: true });

    expect(await changes()).toEqual([
      {
        itemId: 'buzz-50',
        userId: MOD,
        action: 'retire',
        changes: { active: { from: true, to: false } },
      },
      {
        itemId: 'buzz-50',
        userId: MOD,
        action: 'restore',
        changes: { active: { from: false, to: true } },
      },
    ]);
  });
});

describe('previewShop', () => {
  it('rotates the active, sellable items exactly as the shop does, and reports the rest', async () => {
    for (let i = 0; i < 8; i++) await seedItem(`rot-${i}`, { rotating: true, sortOrder: i });
    await seedItem('fixed', { sortOrder: 20 });
    await seedItem('retired', { active: false });
    await seedItem('three-months', { kind: 'membership', buzz: null, tier: 'gold', months: 3 });

    const preview = await previewShop('2026-12-20');
    const sellable = (
      await db.query<Parameters<typeof stockFor>[0][number]>(
        `SELECT * FROM "KnightsShopItem" WHERE "active"`
      )
    ).rows.filter(isSellable);

    expect(preview.stock.map((s) => [s.item.id, s.price, s.deal])).toEqual(
      stockFor(sellable, '2026-12-20').stock.map((s) => [s.item.id, s.price, s.deal])
    );
    expect(preview.stock.map((s) => s.item.id)).toContain('fixed');
    expect(preview.stock.map((s) => s.item.id)).not.toContain('retired');
    expect(preview.excluded.map((i) => i.id)).toEqual(['three-months']);
  });
});

describe('previewShop cosmetics', () => {
  it('keeps an item whose cosmetic is missing in its slot but flags it as hidden from players', async () => {
    await db.query(`INSERT INTO "Cosmetic" ("id","name","type") VALUES (1,'Halo','Badge')`);
    await seedItem('cosmetic-1', { kind: 'cosmetic', buzz: null, cosmeticId: 1, sortOrder: 1 });
    await seedItem('cosmetic-2', { kind: 'cosmetic', buzz: null, cosmeticId: 2, sortOrder: 2 });
    await seedItem('buzz-50', { sortOrder: 3 });

    const { stock } = await previewShop('2026-12-20');
    expect(stock.map((s) => [s.item.id, s.hidden])).toEqual([
      ['cosmetic-1', null],
      ['cosmetic-2', 'cosmetic missing'],
      ['buzz-50', null],
    ]);
  });
});

describe('listShopChanges', () => {
  it('pages newest first by id and keeps the item filter across pages', async () => {
    await seedItem('buzz-50');
    await seedItem('buzz-100');
    for (let i = 0; i < 3; i++) {
      await setShopItemActive('buzz-50', i % 2 === 1, MOD);
    }
    await setShopItemActive('buzz-100', false, MOD);

    const first = await listShopChanges({ limit: 3 });
    expect(first.changes).toHaveLength(3);
    expect(first.nextBefore).toBe(first.changes[2].id);

    const second = await listShopChanges({ limit: 3, before: first.nextBefore ?? undefined });
    expect(second.changes).toHaveLength(1);
    expect(second.nextBefore).toBeNull();
    const ids = [...first.changes, ...second.changes].map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(4);

    const filtered = await listShopChanges({ itemId: 'buzz-50', limit: 2 });
    expect(filtered.changes.every((c) => c.itemId === 'buzz-50')).toBe(true);
    expect(filtered.nextBefore).toBe(filtered.changes[1].id);
    const rest = await listShopChanges({
      itemId: 'buzz-50',
      limit: 2,
      before: filtered.nextBefore ?? undefined,
    });
    expect(rest.changes).toHaveLength(1);
    expect(rest.nextBefore).toBeNull();
  });
});
