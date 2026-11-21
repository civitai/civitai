import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODEL_ELIGIBLE_SQL } from '../../../../apps/event-engine/src/vector-sync/models/source';
import { modelSearchIndexEligibilitySql } from '~/server/search-index/model-index-eligibility';

// The event-engine's model vector rule is the site's search-index rule plus its own exclusions, so
// it must never keep a model the site's rule drops.
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished',
      'UnpublishedViolation', 'GatherInterest', 'Deleted');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TABLE "Model" (id int PRIMARY KEY, status "ModelStatus" NOT NULL,
      availability "Availability" NOT NULL, mode "ModelModifier", "deletedAt" timestamp(3),
      "tosViolation" boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      "publishedAt" timestamp(3) DEFAULT now());
    INSERT INTO "Model" (id, status, availability, mode) VALUES
      (1, 'Published', 'Public', NULL),
      (2, 'Published', 'Public', 'Archived'),
      (3, 'Published', 'Public', 'TakenDown'),
      (4, 'Published', 'Unsearchable', NULL),
      (5, 'Draft', 'Public', NULL),
      (6, 'Unpublished', 'Public', NULL),
      (7, 'Published', 'EarlyAccess', NULL),
      (8, 'Published', 'EarlyAccess', 'TakenDown'),
      (9, 'Published', 'Private', NULL);
  `);
});
afterAll(() => pg.close());

async function siteIds() {
  const q = Prisma.sql`SELECT m.id FROM "Model" m WHERE ${modelSearchIndexEligibilitySql()}`;
  const { rows } = await pg.query<{ id: number }>(q.text, q.values as unknown[]);
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

async function vectorIds() {
  const { rows } = await pg.query<{ id: number }>(
    `SELECT m.id FROM "Model" m WHERE ${MODEL_ELIGIBLE_SQL} ORDER BY m.id`
  );
  return rows.map((r) => r.id);
}

describe('model vector index eligibility', () => {
  it('keeps published models, archived ones included, and drops taken-down ones', async () => {
    expect(await vectorIds()).toEqual([1, 2, 7]);
  });

  it('keeps no model the site search index drops', async () => {
    const site = new Set(await siteIds());
    expect((await vectorIds()).filter((id) => !site.has(id))).toEqual([]);
  });
});
