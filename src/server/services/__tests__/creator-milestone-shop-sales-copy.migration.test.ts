import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The shop-sales copy fix runs by hand and may run twice, so its guard is the logic worth pinning:
 * rewrite all five rows, no-op on a re-run, refuse a half-matching table.
 */

const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');
const read = (dir: string) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
const SEED = read('20261009120000_creator_milestone_earn');
const COPY_FIX = read('20261019120000_creator_milestone_shop_sales_copy');

const OLD = [
  'Sold 100,000 Buzz from your shop.',
  'Sold 250,000 Buzz from your shop.',
  'Sold 500,000 Buzz from your shop.',
  'Sold 1,000,000 Buzz from your shop.',
  'Sold 2,000,000 Buzz from your shop.',
];
const NEW = [
  'Earned 100,000 Buzz from shop sales.',
  'Earned 250,000 Buzz from shop sales.',
  'Earned 500,000 Buzz from shop sales.',
  'Earned 1,000,000 Buzz from shop sales.',
  'Earned 2,000,000 Buzz from shop sales.',
];

let db: PGlite;

async function descriptions() {
  return (
    await db.query<{ description: string }>(
      `SELECT description FROM "CreatorMilestone" WHERE key LIKE 'earn:shop-sales-%' ORDER BY threshold`
    )
  ).rows.map((r) => r.description);
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "CreatorMilestone" (
      key text PRIMARY KEY, track text, threshold int, name text, description text,
      "sortOrder" int, "cosmeticId" int
    );
  `);
  await db.exec(SEED);
  await db.exec(`
    INSERT INTO "CreatorMilestone" (key, track, threshold, name, description)
    VALUES ('reach:downloads-1000', 'reach', 1000, '1k Downloads', 'Sold 1 Buzz from your shop.');
  `);
});

describe('20261019120000_creator_milestone_shop_sales_copy', () => {
  it('starts from the old copy, so the rewrite is not already satisfied', async () => {
    expect(await descriptions()).toEqual(OLD);
  });

  it('rewrites the five shop-sales rows and leaves other rows alone', async () => {
    await db.exec(COPY_FIX);
    expect(await descriptions()).toEqual(NEW);
    const other = await db.query<{ description: string }>(
      `SELECT description FROM "CreatorMilestone" WHERE key = 'reach:downloads-1000'`
    );
    expect(other.rows[0].description).toBe('Sold 1 Buzz from your shop.');
  });

  it('changes nothing when applied again', async () => {
    await db.exec(COPY_FIX);
    await db.exec(COPY_FIX);
    expect(await descriptions()).toEqual(NEW);
  });

  it('refuses a table where only some rows still carry the old text', async () => {
    await db.exec(
      `UPDATE "CreatorMilestone" SET description = 'edited' WHERE key = 'earn:shop-sales-100000'`
    );
    await expect(db.exec(COPY_FIX)).rejects.toThrow(/expected 0 or 5 rows, changed 4/);
    expect(await descriptions()).toEqual(['edited', ...OLD.slice(1)]);
  });
});
