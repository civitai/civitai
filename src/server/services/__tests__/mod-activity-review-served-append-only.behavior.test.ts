import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, expect, it, vi } from 'vitest';
import { REVIEW_SERVED_ACTIVITY } from '@civitai/shared/review-batch';

/**
 * A general-tier review batch's view rows are its audit, as the held and retracted view rows are
 * theirs: they cannot be updated or deleted. Runs the append-only migrations in order on a Postgres
 * stand-in.
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
  await pg.exec(read('20271120190000_mod_activity_review_served_append_only'));
});

const insert = async (activity: string, createdAt = '2000-01-01') =>
  (
    await pg.query<{ id: number; createdAt: Date }>(
      `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId", "createdAt")
       VALUES (10, 'image', $1, 501, $2) RETURNING id, "createdAt"`,
      [activity, createdAt]
    )
  ).rows[0];

it('a review view row cannot be deleted, updated or made from another row', async () => {
  const { id } = await insert(REVIEW_SERVED_ACTIVITY);
  await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [id])).rejects.toThrow(
    /review-media-served row and cannot be changed or removed/
  );
  await expect(
    pg.query(`UPDATE "ModActivity" SET "entityId" = 2 WHERE id = $1`, [id])
  ).rejects.toThrow(/cannot be changed or removed/);
  const grid = await insert('heldMedia:grid');
  await expect(
    pg.query(`UPDATE "ModActivity" SET activity = $1 WHERE id = $2`, [
      REVIEW_SERVED_ACTIVITY,
      grid.id,
    ])
  ).rejects.toThrow(/cannot become a review-media-served row/);
});

it("a review view row carries the database's time, not the writer's", async () => {
  const { createdAt } = await insert(REVIEW_SERVED_ACTIVITY);
  expect(createdAt.getUTCFullYear()).toBeGreaterThan(2000);
});

it('keeps the earlier guards, and other rows stay deletable and keep their time', async () => {
  for (const activity of ['heldMedia:view', 'retractedMedia:view', 'preservedFile:served']) {
    const { id } = await insert(activity);
    await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [id])).rejects.toThrow(
      /cannot be changed or removed/
    );
  }
  const grid = await insert('heldMedia:grid');
  expect(grid.createdAt.getUTCFullYear()).toBe(2000);
  await pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [grid.id]);
});
