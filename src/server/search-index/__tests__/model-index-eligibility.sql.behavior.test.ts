import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { modelSearchIndexEligibilitySql } from '~/server/search-index/model-index-eligibility';

// Run in real Postgres: NULL handling in `mode != 'TakenDown'` is invisible to a string-shape test.
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private');
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TABLE "Model" (id int PRIMARY KEY, status "ModelStatus", availability "Availability",
      mode "ModelModifier");
    INSERT INTO "Model" VALUES
      (1, 'Published', 'Public', NULL),
      (2, 'Published', 'Public', 'Archived'),
      (3, 'Published', 'Public', 'TakenDown'),
      (4, 'Published', 'Unsearchable', NULL),
      (5, 'Draft', 'Public', NULL);
  `);
});
afterAll(() => pg.close());

it('keeps published, searchable models that are not taken down', async () => {
  const q = Prisma.sql`SELECT m.id FROM "Model" m WHERE ${modelSearchIndexEligibilitySql()} ORDER BY m.id`;
  const { rows } = await pg.query<{ id: number }>(q.text, q.values as unknown[]);
  expect(rows.map((r) => r.id)).toEqual([1, 2]);
});
