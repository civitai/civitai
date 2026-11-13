import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogParams, designName, EMPTY_FILTERS } from '$lib/box-design';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
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

const { searchCosmeticCatalog, createCosmeticDefinitions, readRewards, withShelfPrices } =
  await import('../item-definitions.service');
const { catalogQuerySchema } = await import('../catalog-query');
type Query = Parameters<typeof searchCosmeticCatalog>[0];

const MIGRATIONS = [
  '20261105120000_mystery_box_items',
  '20261107120000_mystery_box_listing_unlisted_and_refunds',
].map((name) =>
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      `../../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  )
);

const BASE = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY);
CREATE TABLE "Cosmetic" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'ContentDecoration',
  "data" JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE "CosmeticShopItem" (
  "id" SERIAL PRIMARY KEY,
  "cosmeticId" INTEGER,
  "unitAmount" INTEGER NOT NULL,
  "addedById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "availableFrom" TIMESTAMP(3),
  "availableTo" TIMESTAMP(3),
  "availableQuantity" INTEGER,
  "meta" JSONB NOT NULL DEFAULT '{}',
  "title" TEXT NOT NULL DEFAULT 't',
  "description" TEXT,
  "archivedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "listed" BOOLEAN NOT NULL DEFAULT true
);
`;

const ANY: Query = {
  q: '',
  event: '',
  noEvent: false,
  types: [],
  team: '',
  minShelf: null,
  maxShelf: null,
  noShelf: false,
  needsDefinition: false,
  limit: 100,
};

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(BASE);
  for (const migration of MIGRATIONS) await db.exec(migration);
  await db.exec(`
    INSERT INTO "Cosmetic" ("id", "name", "type", "data") VALUES
      (1, 'Cap - Blue',   'ContentDecoration', '{"event":"party","team":"Blue","url":"u1"}'),
      (2, 'Cap - Pink',   'ContentDecoration', '{"event":"party","team":"Pink","url":"u2"}'),
      (3, 'Crown - Blue', 'ContentDecoration', '{"event":"party","team":"Blue"}'),
      (4, 'Crown - Pink', 'ContentDecoration', '{"event":"party","team":"Pink"}'),
      (5, 'Confetti',     'ContentDecoration', '{"event":"party"}'),
      (6, 'Gold Badge',   'Badge',             '{"url":"b"}'),
      (7, '100% Fan',     'Badge',             '{}'),
      (8, 'Old Cap - Blue','ContentDecoration','{"event":"party","team":"Pink"}'),
      (9, 'Odd - Team',   'Badge',             '{"team":7}');
    INSERT INTO "CosmeticShopItem" ("cosmeticId", "unitAmount", "status", "archivedAt") VALUES
      (1, 500,  'Published', NULL),
      (2, 900,  'Published', NULL),
      (3, 3000, 'Published', NULL),
      (4, 3000, 'Published', NULL),
      (6, 700,  'Published', NULL),
      (7, 9000, 'Draft',     NULL),
      (5, 100,  'Published', now());
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  await createCosmeticDefinitions({ selector: { cosmeticIds: [1, 2, 6] }, userId: 5 });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const search = (over: Partial<Query> = {}) => searchCosmeticCatalog({ ...ANY, ...over });
const names = async (over: Partial<Query> = {}) => (await search(over)).designs.map((d) => d.name);

describe('the catalog request', () => {
  it('is read by the route exactly as the panel writes it', () => {
    const filters = {
      ...EMPTY_FILTERS,
      q: 'cap',
      event: 'party',
      types: ['Badge', 'Sticker'],
      team: 'Pink',
      band: 'rare' as const,
      needsDefinition: true,
      limit: 96,
    };
    const parsed = catalogQuerySchema.parse(
      Object.fromEntries(catalogParams(filters, { uncommon: 500, rare: 1500 }))
    );
    expect(parsed).toEqual({
      q: 'cap',
      event: 'party',
      noEvent: false,
      types: ['Badge', 'Sticker'],
      team: 'Pink',
      minShelf: 501,
      maxShelf: 1500,
      noShelf: false,
      needsDefinition: true,
      limit: 96,
    });
    const none = catalogQuerySchema.parse(
      Object.fromEntries(
        catalogParams(
          { ...EMPTY_FILTERS, event: '__none', band: 'none' },
          { uncommon: 500, rare: 1500 }
        )
      )
    );
    expect(none).toMatchObject({ noEvent: true, noShelf: true, event: '' });
  });
});

describe('the cosmetic catalog', () => {
  it('returns every variant of a design whose name matches, and prices each variant itself', async () => {
    const { designs } = await search({ event: 'party', q: 'pink' });
    const cap = designs.find((d) => d.name === 'Cap')!;
    expect(cap.variants.map((v) => [v.team, v.shelf])).toEqual([
      ['Blue', 500],
      ['Pink', 900],
    ]);
    expect(cap.shelf).toBe(500);
  });

  it('keys a design the same way a box reward does', async () => {
    const { designs } = await search({ event: 'party', q: 'cap' });
    const cap = designs.find((d) => d.name === 'Cap')!;
    const [{ id }] = (
      await db.query<{ id: number }>(`SELECT id FROM "ItemDefinition" WHERE "cosmeticId" = 1`)
    ).rows;
    const [reward] = await withShelfPrices([
      ...(await readRewards(dbHandle.current as never, [id])).values(),
    ]);
    expect(reward.designKey).toBe(cap.key);
  });

  it('reads a team-variant set as one design, with its variants in team order', async () => {
    const { designs, total } = await search({ event: 'party', q: 'cap' });
    expect(total).toBe(2);
    const cap = designs.find((d) => d.name === 'Cap')!;
    expect(cap.variants.map((v) => v.team)).toEqual(['Blue', 'Pink']);
    expect(cap).toMatchObject({ event: 'party', type: 'ContentDecoration', shelf: 500 });
    expect(cap.variants[0]).toMatchObject({ cosmeticId: 1, name: 'Cap - Blue', url: 'u1' });
  });

  it("strips the suffix exactly as the TypeScript rule does, and only for the cosmetic's own team", async () => {
    const { designs } = await search();
    for (const design of designs)
      for (const variant of design.variants)
        expect(design.name, variant.name).toBe(designName(variant.name, variant.team));
    // Made for Pink, so "Old Cap - Blue" keeps its suffix.
    expect(designs.map((d) => d.name)).toContain('Old Cap - Blue');
    expect(designs.find((d) => d.name === 'Odd - Team')!.variants[0].team).toBeNull();
  });

  it('says which cosmetics have a definition, and gives its id', async () => {
    const { designs } = await search({ event: 'party' });
    const cap = designs.find((d) => d.name === 'Cap')!;
    expect(cap.variants.every((v) => typeof v.definitionId === 'number')).toBe(true);
    const crown = designs.find((d) => d.name === 'Crown')!;
    expect(crown.variants.map((v) => v.definitionId)).toEqual([null, null]);
    expect(await names({ needsDefinition: true })).toEqual(
      expect.not.arrayContaining(['Cap', 'Gold Badge'])
    );
    expect(await names({ needsDefinition: true })).toEqual(
      expect.arrayContaining(['Crown', 'Confetti'])
    );
  });

  it('prices a cosmetic by its published, unarchived shop item, and leaves any other unpriced', async () => {
    const { designs } = await search();
    const byName = (name: string) => designs.find((d) => d.name === name)!;
    expect(byName('Gold Badge').shelf).toBe(700);
    expect(byName('100% Fan').shelf).toBeNull();
    expect(byName('Confetti').shelf).toBeNull();
  });

  it('narrows by name (a % is not a wildcard), event, type, team and price', async () => {
    expect(await names({ q: '100%' })).toEqual(['100% Fan']);
    expect(await names({ q: '%' })).toEqual(['100% Fan']);
    expect((await names({ event: 'party' })).sort()).toEqual([
      'Cap',
      'Confetti',
      'Crown',
      'Old Cap - Blue',
    ]);
    expect((await names({ noEvent: true })).sort()).toEqual([
      '100% Fan',
      'Gold Badge',
      'Odd - Team',
    ]);
    expect(await names({ types: ['Badge'] })).toEqual(['100% Fan', 'Gold Badge', 'Odd - Team']);
    expect((await names({ event: 'party', team: 'Pink' })).sort()).toEqual([
      'Cap',
      'Confetti',
      'Crown',
      'Old Cap - Blue',
    ]);
    expect((await names({ event: 'party', team: 'Green' })).sort()).toEqual(['Confetti']);
    expect((await names({ minShelf: 501, maxShelf: 3000 })).sort()).toEqual([
      'Crown',
      'Gold Badge',
    ]);
    expect((await names({ noShelf: true })).sort()).toEqual([
      '100% Fan',
      'Confetti',
      'Odd - Team',
      'Old Cap - Blue',
    ]);
  });

  it('counts every match but returns only `limit` designs, in name order', async () => {
    const page = await search({ limit: 2 });
    expect(page.designs.map((d) => d.name)).toEqual(['100% Fan', 'Cap']);
    expect(page.total).toBe(7);
  });

  it('prices the rewards already in a box from the same shelf rule', async () => {
    const [{ id }] = (
      await db.query<{ id: number }>(`SELECT id FROM "ItemDefinition" WHERE "cosmeticId" = 1`)
    ).rows;
    const rewards = await withShelfPrices([
      ...(await readRewards(dbHandle.current as never, [id])).values(),
    ]);
    expect(rewards).toEqual([
      expect.objectContaining({ name: 'Cap - Blue', shelf: 500, design: 'Cap', team: 'Blue' }),
    ]);
  });
});
