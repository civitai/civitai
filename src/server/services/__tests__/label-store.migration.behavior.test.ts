import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The label store migration, executed unmodified on an in-process Postgres with the source tables it
 * hooks into. Each case that expects nothing has a twin that differs in one property and does produce
 * something, so an empty result cannot come from a store that records nothing.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261101120000_label_store/migration.sql'
);

const db = { pg: null as unknown as PGlite };

const OWNER = 11;
const IMAGE = 501;
const ITEM = 7;
const MODS = [21, 22, 23];

beforeAll(async () => {
  db.pg = await PGlite.create();
  await db.pg.exec(`
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY,
      "userId" integer NOT NULL,
      "url" text NOT NULL,
      "pHash" bigint,
      "meta" jsonb
    );
    CREATE TABLE "ScanLabelItem" (
      "id" serial PRIMARY KEY,
      "imageId" integer NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE,
      "copyState" text,
      "copyKey" text,
      "copiedAt" timestamptz(3)
    );
    CREATE TABLE "ScanLabelFlag" (
      "id" serial PRIMARY KEY,
      "itemId" integer NOT NULL REFERENCES "ScanLabelItem"("id") ON DELETE CASCADE,
      "source" text NOT NULL,
      "flaggerVersion" text NOT NULL,
      "reason" text,
      "workflowId" text NOT NULL UNIQUE,
      "flaggedAt" timestamptz(3) NOT NULL,
      "snapshot" jsonb,
      "createdAt" timestamptz(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "ScanLabelVote" (
      "itemId" integer NOT NULL REFERENCES "ScanLabelItem"("id") ON DELETE CASCADE,
      "userId" integer NOT NULL,
      "block" boolean NOT NULL,
      "reason" text,
      "reasonComment" text,
      "msOnItem" integer,
      "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
      PRIMARY KEY ("itemId", "userId")
    );
    CREATE TABLE "ScanLabelCopyObject" (
      "key" text PRIMARY KEY,
      "itemId" integer NOT NULL,
      "imageId" integer NOT NULL,
      "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
      "withdrawnAt" timestamptz(3),
      "withdrawReason" text
    );
    CREATE TABLE "AppealDecisionRecord" (
      "id" bigserial PRIMARY KEY,
      "appealId" integer NOT NULL UNIQUE,
      "imageId" integer NOT NULL,
      "imageUrl" text NOT NULL,
      "pHash" bigint,
      "nsfwLevel" integer NOT NULL,
      "nsfwLevelReason" text,
      "aiNsfwLevel" integer,
      "blockedFor" text,
      "decision" text NOT NULL,
      "decidedAt" timestamptz(3) NOT NULL
    );
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    TRUNCATE label_store.subject, label_store.record_failure RESTART IDENTITY CASCADE;
    TRUNCATE "ScanLabelCopyObject", "AppealDecisionRecord", "Image" RESTART IDENTITY CASCADE;
  `);
  await db.pg.query(
    `INSERT INTO "Image" ("id", "userId", "url", "pHash", "meta")
     VALUES ($1, $2, 'u-501', 77, '{"prompt": "a cat"}')`,
    [IMAGE, OWNER]
  );
  await db.pg.query(`INSERT INTO "ScanLabelItem" ("id", "imageId") VALUES ($1, $2)`, [ITEM, IMAGE]);
});

const vote = (userId: number, block: boolean) =>
  db.pg.query(
    `INSERT INTO "ScanLabelVote" ("itemId", "userId", "block", "reason", "msOnItem")
     VALUES ($1, $2, $3, $4, 1500)`,
    [ITEM, userId, block, block ? 'reason-a' : null]
  );

const flag = (workflowId = 'wf-1', source = 'orchestrator-scan') =>
  db.pg.query(
    `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "reason", "workflowId", "flaggedAt", "snapshot")
     VALUES ($1, $2, 'scanner@1', 'hit', $3, '2026-01-01T00:00:00Z', '{"score": 0.9}')`,
    [ITEM, source, workflowId]
  );

const rows = async <T>(sql: string) => (await db.pg.query<T>(sql)).rows;

const consensus = async () =>
  (
    await rows<{
      outcome: string | null;
      humanLabels: number;
      agreeing: number;
      unanimous: boolean;
      trainable: boolean;
      modelValue: string | null;
      modelAgrees: boolean | null;
    }>(`SELECT * FROM label_store.consensus WHERE "question" = 'image.block'`)
  )[0];

describe('votes', () => {
  it('records each vote as a moderator label on the image, without the raw user id', async () => {
    await vote(MODS[0], true);

    const labels = await rows<{
      value: string;
      reason: string;
      labellerKind: string;
      labellerRef: string;
      sourceRef: string;
      msOnItem: number;
      siteId: string;
      subjectType: string;
    }>(`SELECT * FROM label_store.labels_feed`);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      subjectType: 'image',
      siteId: String(IMAGE),
      value: 'block',
      reason: 'reason-a',
      labellerKind: 'moderator',
      msOnItem: 1500,
    });
    expect(labels[0].labellerRef).toMatch(/^[0-9a-f]{64}$/);
    expect(labels[0].sourceRef).toBe(`ScanLabelVote:${ITEM}:${labels[0].labellerRef}`);
  });

  it('three agreeing votes make the subject trainable', async () => {
    for (const m of MODS) await vote(m, false);

    expect(await consensus()).toMatchObject({
      outcome: 'clear',
      humanLabels: 3,
      agreeing: 3,
      unanimous: true,
      trainable: true,
    });
    const examples = await rows(`SELECT * FROM label_store.training_examples`);
    expect(examples).toHaveLength(1);
  });

  it('a split vote has a majority outcome but is not trainable under the unanimous rule', async () => {
    await vote(MODS[0], false);
    await vote(MODS[1], false);
    await vote(MODS[2], true);

    expect(await consensus()).toMatchObject({
      outcome: 'clear',
      humanLabels: 3,
      agreeing: 2,
      unanimous: false,
      trainable: false,
    });
    expect(await rows(`SELECT * FROM label_store.training_examples`)).toHaveLength(0);
  });

  it('two votes are not yet an outcome', async () => {
    await vote(MODS[0], false);
    await vote(MODS[1], false);

    expect(await consensus()).toMatchObject({ outcome: null, humanLabels: 2, trainable: false });
  });
});

describe('flags', () => {
  it('records a flag as the model answering block, and a cleared flag is a pipeline failure', async () => {
    await flag();
    for (const m of MODS) await vote(m, false);

    expect(await consensus()).toMatchObject({ outcome: 'clear', modelValue: 'block', modelAgrees: false });
    const failures = await rows<{ siteId: string }>(`SELECT * FROM label_store.pipeline_failures`);
    expect(failures.map((f) => f.siteId)).toEqual([String(IMAGE)]);
  });

  it('a subject the model was right about is not a failure', async () => {
    await flag();
    for (const m of MODS) await vote(m, true);

    expect(await consensus()).toMatchObject({ outcome: 'block', modelAgrees: true, trainable: true });
    expect(await rows(`SELECT * FROM label_store.pipeline_failures`)).toHaveLength(0);
  });

  it('a control-sample flag records nothing, where a scanner flag does', async () => {
    await flag('wf-control', 'control-sample');
    expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(0);

    await flag('wf-scan', 'orchestrator-scan');
    expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(1);
  });
});

describe('durability', () => {
  it('labels and their consensus outlive the image', async () => {
    for (const m of MODS) await vote(m, false);
    await db.pg.query(`DELETE FROM "Image" WHERE "id" = $1`, [IMAGE]);

    expect(await rows(`SELECT * FROM "ScanLabelVote"`)).toHaveLength(0);
    expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(3);
    expect(await rows(`SELECT * FROM label_store.training_examples`)).toHaveLength(1);
  });

  it('an appeal decision is recorded from the record alone, after its image is gone', async () => {
    await db.pg.query(`DELETE FROM "Image" WHERE "id" = $1`, [IMAGE]);
    await db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "pHash", "nsfwLevel", "decision", "decidedAt")
       VALUES (900, $1, 'u-501', 77, 16, 'Rejected', '2026-01-02T00:00:00Z')`,
      [IMAGE]
    );

    const labels = await rows<{ question: string; value: string; family: string }>(
      `SELECT * FROM label_store.labels_feed`
    );
    expect(labels).toEqual([expect.objectContaining({ question: 'image.appeal', value: 'rejected', family: 'appeal' })]);
  });
});

describe('a label write never fails the write that produced it', () => {
  it('logs a failed label to record_failure and keeps the vote', async () => {
    await db.pg.exec(
      `ALTER TABLE label_store.label ADD CONSTRAINT forced_failure CHECK ("value" <> 'clear')`
    );
    try {
      await vote(MODS[0], false);

      expect(await rows(`SELECT * FROM "ScanLabelVote"`)).toHaveLength(1);
      expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(0);
      const failures = await rows<{ sourceRef: string; error: string }>(
        `SELECT * FROM label_store.record_failure`
      );
      expect(failures).toHaveLength(1);
      expect(failures[0].sourceRef).toMatch(/^ScanLabelVote:7:/);
      expect(failures[0].error).toContain('forced_failure');
    } finally {
      await db.pg.exec(`ALTER TABLE label_store.label DROP CONSTRAINT forced_failure`);
    }
  });

  it('logs a vote whose image cannot be found', async () => {
    await db.pg.exec(`ALTER TABLE "ScanLabelItem" DROP CONSTRAINT "ScanLabelItem_imageId_fkey"`);
    try {
      await db.pg.query(`UPDATE "ScanLabelItem" SET "imageId" = 999 WHERE "id" = $1`, [ITEM]);
      await vote(MODS[0], false);

      expect(await rows(`SELECT * FROM "ScanLabelVote"`)).toHaveLength(1);
      expect(await rows(`SELECT "error" FROM label_store.record_failure`)).toEqual([
        { error: 'image not found' },
      ]);
    } finally {
      await db.pg.query(`UPDATE "ScanLabelItem" SET "imageId" = $1 WHERE "id" = $2`, [IMAGE, ITEM]);
      await db.pg.exec(
        `ALTER TABLE "ScanLabelItem" ADD CONSTRAINT "ScanLabelItem_imageId_fkey"
         FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE`
      );
    }
  });
});

describe('bytes and exclusion', () => {
  it('a copy becomes the subject bytes, and an excluded withdrawal takes the subject out of training', async () => {
    for (const m of MODS) await vote(m, false);
    await db.pg.query(
      `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/u-501', "copiedAt" = now() WHERE "id" = $1`,
      [ITEM]
    );
    expect(
      await rows<{ bytesRef: string }>(`SELECT "bytesRef" FROM label_store.training_examples`)
    ).toEqual([{ bytesRef: 'scan-label-copy:k/u-501' }]);

    await db.pg.query(
      `INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('k/u-501', $1, $2)`,
      [ITEM, IMAGE]
    );
    await db.pg.query(
      `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'excluded'`
    );

    expect(await rows(`SELECT * FROM label_store.training_examples`)).toHaveLength(0);
    const subject = await rows<{ excludedReason: string; snapshot: unknown; bytesRef: unknown }>(
      `SELECT * FROM label_store.subject`
    );
    expect(subject).toEqual([
      expect.objectContaining({ excludedReason: 'safety', snapshot: null, bytesRef: null }),
    ]);
    expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(3);
  });

  it('a withdrawal for any other reason drops the bytes but keeps the subject trainable', async () => {
    for (const m of MODS) await vote(m, false);
    await db.pg.query(
      `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/u-501', "copiedAt" = now() WHERE "id" = $1`,
      [ITEM]
    );
    await db.pg.query(
      `INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('k/u-501', $1, $2)`,
      [ITEM, IMAGE]
    );
    await db.pg.query(`UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'gone'`);

    expect(
      await rows<{ bytesRef: unknown }>(`SELECT "bytesRef" FROM label_store.training_examples`)
    ).toEqual([{ bytesRef: null }]);
  });

  it('erasing an owner deletes their subjects and labels, and leaves other owners alone', async () => {
    await vote(MODS[0], false);
    await db.pg.exec(
      `INSERT INTO "Image" ("id", "userId", "url") VALUES (502, 12, 'u-502');
       INSERT INTO "ScanLabelItem" ("id", "imageId") VALUES (8, 502);`
    );
    await db.pg.query(
      `INSERT INTO "ScanLabelVote" ("itemId", "userId", "block") VALUES (8, $1, false)`,
      [MODS[0]]
    );

    const [{ n }] = await rows<{ n: number }>(`SELECT label_store.erase_owner(${OWNER}) AS n`);
    expect(n).toBe(1);
    expect(await rows<{ siteId: string }>(`SELECT "siteId" FROM label_store.labels_feed`)).toEqual([
      { siteId: '502' },
    ]);
  });
});

describe('backfill', () => {
  it('rebuilds the labels of rows that predate the store, and a re-run adds nothing', async () => {
    await flag();
    for (const m of MODS) await vote(m, false);
    const before = await rows(`SELECT "sourceRef", "value" FROM label_store.label ORDER BY "sourceRef"`);
    expect(before).toHaveLength(4);
    await db.pg.exec(`TRUNCATE label_store.subject RESTART IDENTITY CASCADE`);

    const first = await rows<{ source: string; rows: number; labelsAdded: number }>(
      `SELECT * FROM label_store.backfill()`
    );
    expect(first).toEqual(
      expect.arrayContaining([
        { source: 'ScanLabelFlag', rows: 1, labelsAdded: 1 },
        { source: 'ScanLabelVote', rows: 3, labelsAdded: 3 },
      ])
    );
    expect(
      await rows(`SELECT "sourceRef", "value" FROM label_store.label ORDER BY "sourceRef"`)
    ).toEqual(before);
    expect(await consensus()).toMatchObject({ outcome: 'clear', modelAgrees: false, trainable: true });

    const second = await rows<{ labelsAdded: number }>(`SELECT * FROM label_store.backfill()`);
    expect(second.map((r) => r.labelsAdded)).toEqual([0, 0, 0]);
    expect(await rows(`SELECT * FROM label_store.record_failure`)).toHaveLength(0);
  });
});

describe('the reader role', () => {
  it('reads the views and nothing else, and cannot hash user ids', async () => {
    await vote(MODS[0], false);
    await db.pg.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_reader') THEN
          CREATE ROLE label_reader;
        END IF;
      END $$;
    `);
    // The grant block from the migration, re-run once the role exists.
    const grant = readFileSync(MIGRATION, 'utf8').match(/DO \$\$\r?\nBEGIN\r?\n {2}IF EXISTS[\s\S]*?\r?\n\$\$;/);
    expect(grant).not.toBeNull();
    await db.pg.exec(grant![0]);

    await db.pg.exec(`SET ROLE label_reader`);
    try {
      expect(await rows(`SELECT * FROM label_store.labels_feed`)).toHaveLength(1);
      await expect(db.pg.query(`SELECT * FROM label_store.label`)).rejects.toThrow(/permission denied/);
      await expect(db.pg.query(`SELECT * FROM label_store.secret`)).rejects.toThrow(/permission denied/);
      await expect(db.pg.query(`SELECT label_store.person_hash('labeller', 21)`)).rejects.toThrow(
        /permission denied/
      );
    } finally {
      await db.pg.exec(`RESET ROLE`);
    }
  });
});
