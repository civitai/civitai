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
  await db.pg.exec(migration('20261230140000_scan_label_csam_hold'));
  await db.pg.exec(migration('20261230140100_scan_label_csam_hold_label_store'));
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

describe('a csam-realistic vote', () => {
  it('is excluded as it is recorded, with no snapshot, before the image is flagged', async () => {
    await db.pg.exec(`
      INSERT INTO "Image" ("id", "userId", "url", "pHash", "meta")
        VALUES (601, 12, 'u-601', 78, '{"prompt": "p"}');
      INSERT INTO "ScanLabelItem" ("id", "imageId", "firstFlaggedAt") VALUES (8, 601, now());
      INSERT INTO "ScanLabelVote" ("itemId", "userId", "block", "reason", "msOnItem")
        VALUES (8, 31, true, 'csam-realistic', 500);
    `);
    expect(
      await rows(
        `SELECT "excludedReason", "snapshot", "pHash" FROM label_store.subject
         WHERE "subjectType" = 'image' AND "subjectId" = '601'`
      )
    ).toEqual([{ excludedReason: 'safety', snapshot: null, pHash: null }]);
    expect(await rows(`SELECT * FROM label_store.record_failure`)).toEqual([]);
  });
  it('is excluded even when recording the vote fails, if its scan flag made the image a subject', async () => {
    await db.pg.exec(`
      INSERT INTO "Image" ("id", "userId", "url", "pHash", "meta")
        VALUES (701, 13, 'u-701', 79, '{"prompt": "p"}');
      INSERT INTO "ScanLabelItem" ("id", "imageId", "firstFlaggedAt") VALUES (9, 701, now());
      INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "workflowId", "flaggedAt")
        VALUES (9, 'orchestrator-scan', 'scanner@1', 'wf-701', now());
    `);
    const subject = `SELECT "excludedReason", "snapshot" IS NULL AS "noSnapshot" FROM label_store.subject
       WHERE "subjectType" = 'image' AND "subjectId" = '701'`;
    expect(await rows(subject)).toEqual([{ excludedReason: null, noSnapshot: false }]);
    // A stub that throws, with record_label's own parameter names, rolled back after.
    await db.pg.exec('BEGIN');
    let during: unknown;
    let failures: unknown[];
    try {
      await db.pg.exec(`
        CREATE OR REPLACE FUNCTION label_store.record_label(
          p_subject_type TEXT, p_subject_id TEXT, p_content_hash TEXT, p_family TEXT, p_question TEXT,
          p_value TEXT, p_labeller_kind TEXT, p_source_ref TEXT, p_labelled_at TIMESTAMPTZ,
          p_labeller_user_id INTEGER DEFAULT NULL, p_labeller_ref TEXT DEFAULT NULL,
          p_question_version INTEGER DEFAULT 1, p_reason TEXT DEFAULT NULL,
          p_reason_note TEXT DEFAULT NULL, p_ms_on_item INTEGER DEFAULT NULL,
          p_snapshot JSONB DEFAULT NULL, p_phash BIGINT DEFAULT NULL, p_owner_user_id INTEGER DEFAULT NULL
        ) RETURNS BIGINT LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'record_label down'; END; $$;
        INSERT INTO "ScanLabelVote" ("itemId", "userId", "block", "reason", "msOnItem")
          VALUES (9, 32, true, 'csam-realistic', 500);
      `);
      [during] = await rows(subject);
      failures = await rows(
        `SELECT 1 FROM label_store.record_failure WHERE "error" LIKE '%record_label down%'`
      );
    } finally {
      await db.pg.exec('ROLLBACK');
    }
    expect(during).toEqual({ excludedReason: 'safety', noSnapshot: true });
    expect(failures).toHaveLength(1);
  });
});
