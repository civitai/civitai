import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `reportMedia:*` rows of ModActivity cannot be changed or removed, nor can any row become one;
 * every other row behaves as before. Runs the migration against a Postgres stand-in.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const migration = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_mod_activity_report_media_append_only/migration.sql'
);

const pg = new PGlite();

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER,
      "activity" TEXT NOT NULL,
      "entityType" TEXT,
      "entityId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "host" TEXT
    );
  `);
  expect(existsSync(migration)).toBe(true);
  await pg.exec(readFileSync(migration, 'utf8'));
});

let shown: number;
let other: number;
beforeEach(async () => {
  await pg.exec(`DELETE FROM "ModActivity" WHERE activity NOT LIKE 'reportMedia:%'`);
  const insert = async (activity: string) =>
    (
      await pg.query<{ id: number }>(
        `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
         VALUES (10, 'image', $1, 501) RETURNING id`,
        [activity]
      )
    ).rows[0].id;
  shown = await insert('reportMedia:select:original');
  other = await insert('heldMedia:view');
});

describe('reportMedia rows', () => {
  it('cannot be updated', async () => {
    await expect(
      pg.query(`UPDATE "ModActivity" SET "userId" = 11 WHERE id = $1`, [shown])
    ).rejects.toThrow(/cannot be changed or removed/);
    await expect(
      pg.query(`UPDATE "ModActivity" SET "createdAt" = '2020-01-01' WHERE id = $1`, [shown])
    ).rejects.toThrow(/cannot be changed or removed/);
  });

  it('cannot be renamed into another kind of row', async () => {
    await expect(
      pg.query(`UPDATE "ModActivity" SET activity = 'heldMedia:view' WHERE id = $1`, [shown])
    ).rejects.toThrow(/cannot be changed or removed/);
  });

  it('cannot be deleted', async () => {
    await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [shown])).rejects.toThrow(
      /cannot be changed or removed/
    );
  });

  it('cannot be made from another row', async () => {
    await expect(
      pg.query(`UPDATE "ModActivity" SET activity = 'reportMedia:open:original' WHERE id = $1`, [
        other,
      ])
    ).rejects.toThrow(/cannot become a reportMedia row/);
  });

  it('the table cannot be truncated', async () => {
    await expect(pg.exec(`TRUNCATE "ModActivity"`)).rejects.toThrow(/cannot be truncated/);
  });

  it('can still be inserted', async () => {
    await pg.query(
      `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
       VALUES (12, 'image', 'reportMedia:open:cdn-450', 502)`
    );
    const { rows } = await pg.query(
      `SELECT "userId" FROM "ModActivity" WHERE activity = 'reportMedia:open:cdn-450' AND "entityId" = 502`
    );
    expect(rows).toEqual([{ userId: 12 }]);
  });

  it('are stamped with the database time, whatever time the insert names', async () => {
    const { rows } = await pg.query<{ stamped: boolean }>(
      `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId", "createdAt")
       VALUES (12, 'image', 'reportMedia:select:original', 503, '2020-01-01')
       RETURNING "createdAt" = (now() AT TIME ZONE 'UTC')::timestamp(3) AS stamped`
    );
    expect(rows).toEqual([{ stamped: true }]);
  });

  it('a re-run of the migration keeps them guarded', async () => {
    await pg.exec(readFileSync(migration, 'utf8'));
    await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [shown])).rejects.toThrow(
      /cannot be changed or removed/
    );
  });
});

describe('every other row', () => {
  it('keeps the time its insert names', async () => {
    const { rows } = await pg.query<{ createdAt: Date }>(
      `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId", "createdAt")
       VALUES (12, 'image', 'heldMedia:view', 503, '2020-01-01') RETURNING "createdAt"`
    );
    expect(rows[0].createdAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('can be updated and deleted', async () => {
    await pg.query(`UPDATE "ModActivity" SET "userId" = 11 WHERE id = $1`, [other]);
    const { rows } = await pg.query<{ userId: number }>(
      `SELECT "userId" FROM "ModActivity" WHERE id = $1`,
      [other]
    );
    expect(rows[0].userId).toBe(11);
    await pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [other]);
    const left = await pg.query(`SELECT 1 FROM "ModActivity" WHERE id = $1`, [other]);
    expect(left.rows).toHaveLength(0);
  });
});
