import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The judge rename runs by hand against prod, where the badges are linked through cosmeticId. The
 * other suites replaying the migrations hold no linked cosmetics, so only this one sees the badge
 * arm rename anything, or leave an unrelated badge alone.
 */

const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');
const read = (dir: string) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
const RENAME = read('20261012120000_creator_milestone_judge_rename');

const db = new PGlite();

async function names() {
  return (
    await db.query<{ key: string; name: string; badge: string | null }>(
      `SELECT m.key, m.name, c.name AS badge
       FROM "CreatorMilestone" m LEFT JOIN "Cosmetic" c ON c.id = m."cosmeticId"
       ORDER BY m.key`
    )
  ).rows;
}

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, name text);
    CREATE TABLE "CreatorMilestone" (
      key text PRIMARY KEY, track text, threshold int, name text, description text,
      "sortOrder" int, "cosmeticId" int
    );
  `);
  await db.exec(read('20261009140000_creator_milestone_community'));
  await db.exec(`
    INSERT INTO "Cosmetic" VALUES
      (2913, 'Bronze Judge Creator Badge'), (2909, 'Silver Judge Creator Badge'),
      (2911, 'Gold Judge Creator Badge'), (2910, 'Platinum Judge Creator Badge'),
      (2912, 'Diamond Judge Creator Badge'), (100, 'Downloads Art');
    UPDATE "CreatorMilestone" SET "cosmeticId" = CASE key
      WHEN 'community:crucible-votes-500' THEN 2913
      WHEN 'community:crucible-votes-1000' THEN 2909
      WHEN 'community:crucible-votes-5000' THEN 2911
      WHEN 'community:crucible-votes-10000' THEN 2910
      WHEN 'community:crucible-votes-25000' THEN 2912 END;
    INSERT INTO "CreatorMilestone" (key, track, threshold, name, "cosmeticId")
    VALUES ('reach:downloads-1000', 'reach', 1000, '1k Downloads', 100);
  `);
  await db.exec(RENAME);
});

afterAll(() => db.close());

const EXPECTED = [
  { key: 'community:crucible-votes-1000', name: '1k Judged', badge: '1k Judged Creator Badge' },
  { key: 'community:crucible-votes-10000', name: '10k Judged', badge: '10k Judged Creator Badge' },
  { key: 'community:crucible-votes-25000', name: '25k Judged', badge: '25k Judged Creator Badge' },
  { key: 'community:crucible-votes-500', name: '500 Judged', badge: '500 Judged Creator Badge' },
  { key: 'community:crucible-votes-5000', name: '5k Judged', badge: '5k Judged Creator Badge' },
  { key: 'reach:downloads-1000', name: '1k Downloads', badge: 'Downloads Art' },
];

describe('20261012120000_creator_milestone_judge_rename', () => {
  it('renames each judging milestone and its linked badge, and nothing else', async () => {
    expect(await names()).toEqual(EXPECTED);
  });

  it('changes nothing when applied again', async () => {
    await db.exec(RENAME);
    expect(await names()).toEqual(EXPECTED);
  });
});
