import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVED_ACTIVITY } from '@civitai/shared/held-media';
import { RETRACTED_SERVED_ACTIVITY } from '@civitai/shared/retracted-media';

/**
 * The `retractedMedia:view` rows of ModActivity follow the same append-only rules as the
 * `reportMedia:*` rows. Runs the earlier append-only migration and then this one against a Postgres
 * stand-in, as they apply in order.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const migrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const earlier = readFileSync(
  path.join(migrations, '20261209120000_mod_activity_report_media_append_only/migration.sql'),
  'utf8'
);
const migration = readFileSync(
  path.join(migrations, '20271118090000_mod_activity_retracted_media_append_only/migration.sql'),
  'utf8'
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
  await pg.exec(earlier);
  await pg.exec(migration);
});

const insert = async (activity: string, createdAt?: string) =>
  (
    await pg.query<{ id: number; stamped: boolean }>(
      `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId", "createdAt")
       VALUES (10, 'image', $1, 501, COALESCE($2::timestamp, CURRENT_TIMESTAMP))
       RETURNING id, "createdAt" = (now() AT TIME ZONE 'UTC')::timestamp(3) AS stamped`,
      [activity, createdAt ?? null]
    )
  ).rows[0];

let retracted: number;
let report: number;
let other: number;
beforeEach(async () => {
  retracted = (await insert(RETRACTED_SERVED_ACTIVITY)).id;
  report = (await insert('reportMedia:select:original')).id;
  other = (await insert('heldMedia:grid')).id;
});

describe('retractedMedia:view rows', () => {
  it('cannot be updated', async () => {
    await expect(
      pg.query(`UPDATE "ModActivity" SET "userId" = 11 WHERE id = $1`, [retracted])
    ).rejects.toThrow(/cannot be changed or removed/);
  });

  it('cannot be deleted', async () => {
    await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [retracted])).rejects.toThrow(
      /cannot be changed or removed/
    );
  });

  it('cannot be made from another row', async () => {
    await expect(
      pg.query(`UPDATE "ModActivity" SET activity = $1 WHERE id = $2`, [
        RETRACTED_SERVED_ACTIVITY,
        other,
      ])
    ).rejects.toThrow(/cannot become a retractedMedia:view row/);
  });

  it('are stamped with the database time, whatever time the insert names', async () => {
    expect((await insert(RETRACTED_SERVED_ACTIVITY, '2020-01-01')).stamped).toBe(true);
  });
});

describe('rows the earlier migration covers', () => {
  it('reportMedia rows are still guarded and stamped', async () => {
    await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [report])).rejects.toThrow(
      /cannot be changed or removed/
    );
    await expect(
      pg.query(`UPDATE "ModActivity" SET activity = 'reportMedia:open:original' WHERE id = $1`, [
        other,
      ])
    ).rejects.toThrow(/cannot become a reportMedia:open:original row/);
    expect((await insert('reportMedia:open:cdn-450', '2020-01-01')).stamped).toBe(true);
  });

  it('heldMedia:view rows are still stamped, and still not guarded', async () => {
    const held = await insert(SERVED_ACTIVITY, '2020-01-01');
    expect(held.stamped).toBe(true);
    await pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [held.id]);
  });

  it('the table still cannot be truncated', async () => {
    await expect(pg.exec(`TRUNCATE "ModActivity"`)).rejects.toThrow(/cannot be truncated/);
  });
});

describe('every other row', () => {
  it('keeps the time its insert names', async () => {
    const { rows } = await pg.query<{ createdAt: Date }>(
      `SELECT "createdAt" FROM "ModActivity" WHERE id = $1`,
      [(await insert('heldMedia:grid', '2020-01-01')).id]
    );
    expect(rows[0].createdAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('can be updated and deleted', async () => {
    await pg.query(`UPDATE "ModActivity" SET "userId" = 11 WHERE id = $1`, [other]);
    await pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [other]);
    const left = await pg.query(`SELECT 1 FROM "ModActivity" WHERE id = $1`, [other]);
    expect(left.rows).toHaveLength(0);
  });
});

it('a re-run of the migration keeps retractedMedia:view rows guarded', async () => {
  await pg.exec(migration);
  await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [retracted])).rejects.toThrow(
    /cannot be changed or removed/
  );
});
