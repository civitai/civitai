import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SERVED_ACTIVITY } from '@civitai/shared/held-media';
import { RETRACTED_SERVED_ACTIVITY } from '@civitai/shared/retracted-media';

/**
 * The `heldMedia:view` rows of ModActivity are the view log of held media, kept for years: they
 * cannot be updated or deleted. Runs the three append-only migrations in order on a Postgres stand-in.
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
});

const insert = async (activity: string) =>
  (
    await pg.query<{ id: number }>(
      `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
       VALUES (10, 'image', $1, 501) RETURNING id`,
      [activity]
    )
  ).rows[0].id;

describe('heldMedia:view rows', () => {
  it('cannot be deleted', async () => {
    const id = await insert(SERVED_ACTIVITY);
    await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [id])).rejects.toThrow(
      /heldMedia:view row and cannot be changed or removed/
    );
  });

  it('cannot be updated', async () => {
    const id = await insert(SERVED_ACTIVITY);
    await expect(
      pg.query(`UPDATE "ModActivity" SET "userId" = 11 WHERE id = $1`, [id])
    ).rejects.toThrow(/cannot be changed or removed/);
  });

  it('cannot be made from another row', async () => {
    const id = await insert('heldMedia:grid');
    await expect(
      pg.query(`UPDATE "ModActivity" SET activity = $1 WHERE id = $2`, [SERVED_ACTIVITY, id])
    ).rejects.toThrow(/cannot become a heldMedia:view row/);
  });
});

it('retractedMedia:view rows stay guarded, and other rows stay deletable', async () => {
  const retracted = await insert(RETRACTED_SERVED_ACTIVITY);
  await expect(pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [retracted])).rejects.toThrow(
    /cannot be changed or removed/
  );
  const grid = await insert('heldMedia:grid');
  await pg.query(`DELETE FROM "ModActivity" WHERE id = $1`, [grid]);
});
