import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The preserved-file review's ModActivity rows (apps/moderator) are its audit and its verdicts: a
 * deleted verdict would let the same file be served and ruled again. Runs the four append-only
 * migrations in order on a Postgres stand-in.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const migrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const read = (name: string) => readFileSync(path.join(migrations, name, 'migration.sql'), 'utf8');

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
  await pg.exec(read('20261209120000_mod_activity_report_media_append_only'));
  await pg.exec(read('20271118090000_mod_activity_retracted_media_append_only'));
  await pg.exec(read('20271118230000_mod_activity_held_media_view_append_only'));
  await pg.exec(read('20271120090000_mod_activity_preserved_file_append_only'));
});

const insert = async (activity: string, createdAt = '2000-01-01') =>
  (
    await pg.query<{ id: number; createdAt: Date }>(
      `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId", "createdAt")
       VALUES (10, 'preservedFile:0123456789abcdef', $1, 1, $2) RETURNING id, "createdAt"`,
      [activity, createdAt]
    )
  ).rows[0];

const ROWS = [
  'preservedFile:served',
  'preservedFile:delivered',
  'preservedFile:verdict-apparent',
  'preservedFile:verdict-not',
];

describe.each(ROWS)('%s rows', (activity) => {
  it('cannot be deleted', async () => {
    const { id } = await insert(activity);
    await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [id])).rejects.toThrow(
      new RegExp(`${activity} row and cannot be changed or removed`)
    );
  });

  it('cannot be updated', async () => {
    const { id } = await insert(activity);
    await expect(
      pg.query(`UPDATE "ModActivity" SET "entityId" = 2 WHERE id = $1`, [id])
    ).rejects.toThrow(/cannot be changed or removed/);
  });

  it('cannot be made from another row', async () => {
    const { id } = await insert('heldMedia:grid');
    await expect(
      pg.query(`UPDATE "ModActivity" SET activity = $1 WHERE id = $2`, [activity, id])
    ).rejects.toThrow(new RegExp(`cannot become a ${activity} row`));
  });

  it("carries the database's time, not the writer's", async () => {
    const { createdAt } = await insert(activity);
    expect(createdAt.getUTCFullYear()).toBeGreaterThan(2000);
  });
});

it('keeps the earlier guards, and other rows stay deletable and keep their time', async () => {
  const held = await insert('heldMedia:view');
  await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [held.id])).rejects.toThrow(
    /cannot be changed or removed/
  );
  const grid = await insert('heldMedia:grid');
  expect(grid.createdAt.getUTCFullYear()).toBe(2000);
  await pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [grid.id]);
});
