import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The downloads-total migration runs by hand against prod, possibly twice. It rewrites the five
 * Downloads descriptions and the special-achievement badge cosmetics, each only while it still holds
 * the old text. These replay every CreatorMilestone migration before it, then apply it.
 */

const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');
const DOWNLOADS_TOTAL = '20261017120000_creator_milestone_downloads_total';
const read = (dir: string) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');

const earlier = readdirSync(MIGRATIONS)
  .sort()
  .filter((dir) => dir < DOWNLOADS_TOTAL)
  .filter((dir) => {
    try {
      return read(dir).includes('"CreatorMilestone"');
    } catch {
      return false;
    }
  });

const OLD_BADGE = 'Earned a hidden Creator Journey achievement.';
const NEW_BADGE = 'Earned a special Creator Journey achievement.';
// Prod's ids and numbering, which do not run in order.
const BADGES = [
  [2900, 1],
  [2899, 2],
  [2895, 3],
  [2894, 4],
  [2896, 5],
  [2901, 6],
  [2897, 7],
  [2898, 8],
] as const;

let db: PGlite;

async function before() {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY);
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY, name text, description text);
  `);
  for (const dir of earlier) await db.exec(read(dir));
  for (const [id, n] of BADGES)
    await db.query(`INSERT INTO "Cosmetic" (id, name, description) VALUES ($1, $2, $3)`, [
      id,
      `Hidden Achievement Badge ${n}`,
      OLD_BADGE,
    ]);
  // Outside the range, and a name the numbering does not match.
  await db.exec(`
    INSERT INTO "Cosmetic" (id, name, description) VALUES
      (2893, 'Hidden Achievement Badge 1', '${OLD_BADGE}'),
      (100, 'Downloads Art', 'One of your models reached 100 downloads.');
  `);
}

afterEach(() => db?.close());

const descriptions = async () =>
  (
    await db.query<{ key: string; description: string }>(
      `SELECT key, description FROM "CreatorMilestone" ORDER BY key`
    )
  ).rows;

const cosmetics = async () =>
  (
    await db.query<{ id: number; name: string; description: string }>(
      `SELECT id, name, description FROM "Cosmetic" ORDER BY id`
    )
  ).rows;

describe(DOWNLOADS_TOTAL, () => {
  it('rewrites the five Downloads descriptions and nothing else', async () => {
    await before();
    const prior = await descriptions();
    await db.exec(read(DOWNLOADS_TOTAL));
    const after = await descriptions();

    const changed = after.filter((row, i) => row.description !== prior[i].description);
    expect(changed).toEqual([
      { key: 'reach:downloads-100', description: 'Your models reached 100 downloads in total.' },
      { key: 'reach:downloads-1000', description: 'Your models reached 1,000 downloads in total.' },
      {
        key: 'reach:downloads-10000',
        description: 'Your models reached 10,000 downloads in total.',
      },
      {
        key: 'reach:downloads-100000',
        description: 'Your models reached 100,000 downloads in total.',
      },
      {
        key: 'reach:downloads-1000000',
        description: 'Your models reached 1,000,000 downloads in total.',
      },
    ]);
  });

  it('renames each special-achievement badge under its own number, and no other cosmetic', async () => {
    await before();
    await db.exec(read(DOWNLOADS_TOTAL));
    expect(await cosmetics()).toEqual([
      { id: 100, name: 'Downloads Art', description: 'One of your models reached 100 downloads.' },
      { id: 2893, name: 'Hidden Achievement Badge 1', description: OLD_BADGE },
      ...BADGES.map(([id, n]) => ({
        id,
        name: `Special Achievement Badge ${n}`,
        description: NEW_BADGE,
      })).sort((a, b) => a.id - b.id),
    ]);
  });

  it('leaves a row alone once it has been edited by hand', async () => {
    await before();
    await db.exec(`
      UPDATE "CreatorMilestone" SET description = 'Edited.' WHERE key = 'reach:downloads-1000';
      UPDATE "Cosmetic" SET description = 'Edited.' WHERE id = 2894;
    `);
    await db.exec(read(DOWNLOADS_TOTAL));
    const rows = await descriptions();
    expect(rows.find((row) => row.key === 'reach:downloads-1000')?.description).toBe('Edited.');
    expect((await cosmetics()).find((row) => row.id === 2894)).toEqual({
      id: 2894,
      name: 'Hidden Achievement Badge 4',
      description: 'Edited.',
    });
  });

  it('changes nothing when applied again', async () => {
    await before();
    await db.exec(read(DOWNLOADS_TOTAL));
    const once = { descriptions: await descriptions(), cosmetics: await cosmetics() };
    await db.exec(read(DOWNLOADS_TOTAL));
    expect({ descriptions: await descriptions(), cosmetics: await cosmetics() }).toEqual(once);
  });
});
