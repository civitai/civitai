import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orphanedDraftCandidatesSql } from '~/pages/api/admin/temp/republish-orphaned-drafts';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, name text NOT NULL, status text NOT NULL,
      "deletedAt" timestamp(3), poi boolean, minor boolean, meta jsonb
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL, "baseModel" text NOT NULL,
      availability text NOT NULL DEFAULT 'Public', meta jsonb
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "modelVersionId" int, "userId" int NOT NULL, "publishedAt" timestamp(3)
    );
    CREATE TABLE "ModelFile" ("modelVersionId" int NOT NULL, type text NOT NULL);

    INSERT INTO "Model" (id, "userId", name, status, meta) VALUES
      (1, 7, 'ungated', 'Draft', '{}'),
      (2, 7, 'gated', 'Draft', '{}');
    INSERT INTO "ModelVersion" (id, "modelId", status, "baseModel", meta) VALUES
      (10, 1, 'Draft', 'SDXL 1.0', '{}'),
      (20, 2, 'Draft', 'Fibo 2.0', '{}');
    INSERT INTO "Post" (id, "modelVersionId", "userId", "publishedAt") VALUES
      (100, 10, 7, now()),
      (200, 20, 7, now());
    INSERT INTO "ModelFile" ("modelVersionId", type) VALUES (10, 'Model'), (20, 'Model');
  `);
});
afterAll(() => db.close());

const candidateVersionIds = async () => {
  const sql = orphanedDraftCandidatesSql(Prisma.sql`AND m.id IN (1, 2)`);
  const { rows } = await db.query<{ versionId: number }>(sql.text, sql.values);
  return rows.map((r) => r.versionId);
};

describe('orphaned-draft republish candidates', () => {
  it('never republishes a draft on a base model the pre-publish gate covers', async () => {
    expect(await candidateVersionIds()).not.toContain(20);
  });

  it('still republishes an orphaned draft on an ungated base model (control)', async () => {
    expect(await candidateVersionIds()).toEqual([10]);
  });
});
