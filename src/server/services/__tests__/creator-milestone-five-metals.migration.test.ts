import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The five-metal migration runs by hand against prod, possibly twice, and deletes a definition. These
 * replay every CreatorMilestone migration before it, then exercise it the ways a hand apply can go.
 */

const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');
const FIVE_METALS = '20261014130000_creator_milestone_five_metals';
const read = (dir: string) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');

const earlier = readdirSync(MIGRATIONS)
  .sort()
  .filter((dir) => dir < FIVE_METALS)
  .filter((dir) => {
    try {
      return read(dir).includes('"CreatorMilestone"');
    } catch {
      return false;
    }
  });

let db: PGlite;

async function before() {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY);
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY, name text);
  `);
  for (const dir of earlier) await db.exec(read(dir));
}

afterEach(() => db?.close());

const ladders = async () =>
  (
    await db.query<{ track: string; ladder: string; keys: string[]; thresholds: number[] }>(
      `SELECT track, split_part(split_part(key, ':', 2), '-', 1) AS ladder,
         array_agg(key ORDER BY "sortOrder") AS keys,
         array_agg(threshold ORDER BY "sortOrder") AS thresholds
       FROM "CreatorMilestone" WHERE track <> 'score' AND NOT hidden
       GROUP BY 1, 2 ORDER BY 1, 2`
    )
  ).rows;

describe(FIVE_METALS, () => {
  it('leaves every ladder five rungs, ordered by threshold, and removes 50 Wins', async () => {
    await before();
    await db.exec(read(FIVE_METALS));

    const rows = await ladders();
    expect(rows.map((row) => [row.ladder, row.thresholds])).toEqual([
      ['crucible', [500, 1000, 5000, 10000, 25000]],
      ['wins', [1, 5, 10, 25, 100]],
      ['articles', [1, 5, 25, 50, 100]],
      ['models', [1, 5, 25, 100, 500]],
      ['shop', [100000, 250000, 500000, 1000000, 2000000]],
      ['downloads', [100, 1000, 10000, 100000, 1000000]],
      ['followers', [100, 500, 1000, 5000, 10000]],
      ['reactions', [100, 1000, 10000, 100000, 1000000]],
    ]);
  });

  it('changes nothing when applied again', async () => {
    await before();
    await db.exec(read(FIVE_METALS));
    const once = await ladders();
    await db.exec(read(FIVE_METALS));
    expect(await ladders()).toEqual(once);
  });

  // Keys are permanent: a held 50 Wins must survive, so the whole migration aborts instead.
  it('aborts, changing nothing, when anyone holds 50 Wins', async () => {
    await before();
    await db.exec(`
      INSERT INTO "User" (id) VALUES (7);
      INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey") VALUES (7, 'compete:wins-50');
    `);
    const untouched = await ladders();
    await expect(db.exec(read(FIVE_METALS))).rejects.toThrow(
      'compete:wins-50 has holders; not deleting it'
    );
    await db.exec('ROLLBACK').catch(() => undefined);
    expect(await ladders()).toEqual(untouched);
  });
});
