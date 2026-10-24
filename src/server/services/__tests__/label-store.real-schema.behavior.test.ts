import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LABEL_STORE_MIGRATION } from './label-store.fixture';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The store over the source tables as their own migrations create them, not the fixture's subset. The
 * store logs a column it cannot read to record_failure rather than failing the site write, so a renamed
 * source column shows up here as a failure row.
 */

const migration = (dir: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${dir}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };
const rows = async (sql: string) => (await db.pg.query(sql)).rows;

beforeAll(async () => {
  db.pg = await PGlite.create();
  await db.pg.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Model', 'Model3D');
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY, "userId" integer NOT NULL, "url" text NOT NULL, "pHash" bigint,
      "meta" jsonb, "metadata" jsonb, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "aiNsfwLevel" integer NOT NULL DEFAULT 0,
      "blockedFor" text, "needsReview" text
    );
    CREATE TABLE "Appeal" (
      "id" serial PRIMARY KEY, "userId" integer NOT NULL, "entityType" "EntityType" NOT NULL,
      "entityId" integer NOT NULL, "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
      "resolvedAt" timestamp(3), "resolvedReason" text
    );
    CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
  `);
  for (const dir of [
    '20261020120000_appeal_decision_record',
    '20261022130000_scan_label_queue',
    '20261022140000_scan_label_outcomes',
    '20261023130000_scan_label_reasons_copy',
    '20261023140000_scan_label_copy_sweep',
    '20261024130000_scan_label_copy_removed_at',
  ])
    await db.pg.exec(migration(dir));
  await db.pg.exec(readFileSync(LABEL_STORE_MIGRATION, 'utf8'));
});

afterAll(async () => {
  await db.pg.close();
});

describe('on the real source tables', () => {
  it('records a flag, votes, an appeal, a copy and a withdrawal with no failure', async () => {
    await db.pg.exec(`
      INSERT INTO "Image" ("id", "userId", "url", "pHash", "meta")
        VALUES (501, 11, 'u-501', 77, '{"prompt": "a cat"}');
      INSERT INTO "ScanLabelItem" ("id", "imageId", "firstFlaggedAt") VALUES (7, 501, now());
      INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "workflowId", "flaggedAt")
        VALUES (7, 'orchestrator-scan', 'scanner@1', 'wf-1', now());
      INSERT INTO "ScanLabelVote" ("itemId", "userId", "block", "reason", "msOnItem")
        VALUES (7, 21, true, 'graphic-violence', 900), (7, 22, true, 'graphic-violence', 800),
               (7, 23, false, NULL, 700);
      INSERT INTO "Appeal" ("id", "userId", "entityType", "entityId") VALUES (900, 11, 'Image', 501);
      UPDATE "Appeal" SET "status" = 'Rejected', "resolvedAt" = now() WHERE "id" = 900;
      UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/1', "copiedAt" = now() WHERE "id" = 7;
      INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('k/1', 7, 501);
      UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'gone';
    `);

    expect(await rows(`SELECT * FROM label_store.record_failure`)).toEqual([]);
    expect(
      await rows(
        `SELECT "question", count(*)::int AS n FROM label_store.label GROUP BY 1 ORDER BY 1`
      )
    ).toEqual([
      { question: 'image.appeal', n: 1 },
      { question: 'image.block', n: 3 },
    ]);
    expect(await rows(`SELECT "sourceRef" FROM label_store.prediction`)).toEqual([
      { sourceRef: 'ScanLabelFlag:wf-1' },
    ]);
    expect(
      await rows(`SELECT "kind" FROM label_store.change WHERE "kind" = 'subject'`)
    ).toHaveLength(2);
  });
});
