import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { captureImageHeldSql } from '~/server/services/legal-hold.service';

/**
 * The image delete trigger as it is applied (20261019220000_evidence_hold and
 * 20261204120000_evidence_hold_image_prior_state), plus 20261231120100_feedback_capture_owner_hold:
 * a feedback page capture its own state keeps is kept, and nothing else about the trigger changes.
 * Each case runs in a transaction that is rolled back.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) => readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8');
const CAPTURE_MIGRATION = migration('20261231120100_feedback_capture_owner_hold');
const LIVE_KEEP_IMAGE = migration('20261204120000_evidence_hold_image_prior_state');

const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;
const OTHER = 7;
const MARKED = 8;

const BASE_SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    url text NOT NULL DEFAULT 'u',
    "postId" int,
    "nsfwLevel" int NOT NULL DEFAULT 0,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
    "needsReview" text,
    "blockedFor" text,
    minor boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}',
    "updatedAt" timestamp(3),
    "cascadeParentId" int
  );
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "Post" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    title text,
    detail text,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    "publishedAt" timestamp(3),
    "modelVersionId" int,
    "collectionId" int,
    metadata jsonb
  );
  CREATE TABLE "CsamReport" (
    id serial PRIMARY KEY,
    "userId" int,
    "reportSentAt" timestamp(3),
    "archivedAt" timestamp(3),
    images jsonb NOT NULL DEFAULT '[]',
    details jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "AppealDecisionRecord" (
    "imageId" int NOT NULL,
    "imageUrl" text,
    "blockedFor" text,
    decision text NOT NULL,
    "decidedAt" timestamptz NOT NULL DEFAULT now(),
    "removalLabel" text,
    "removalNsfw" text,
    "aiNsfwLevel" int,
    "trainingCopyState" text
  );
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(migration('20261019220000_evidence_hold'));
  await db.exec(LIVE_KEEP_IMAGE);
  await db.exec(CAPTURE_MIGRATION);
  await db.exec(`
    INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKED}, 'manual', 'test');
    INSERT INTO "Image" (id, "userId", "needsReview", "blockedFor", minor) VALUES
      (1, ${CAPTURE}, 'csam', NULL, false),
      (2, ${CAPTURE}, NULL, 'CSAM', false),
      (3, ${CAPTURE}, NULL, NULL, true),
      (4, ${CAPTURE}, NULL, NULL, false),
      (5, ${CAPTURE}, NULL, NULL, false),
      (6, ${CAPTURE}, NULL, NULL, false),
      (10, ${OTHER}, 'csam', NULL, false),
      (11, ${OTHER}, NULL, NULL, false),
      (12, ${MARKED}, NULL, NULL, false);
    INSERT INTO "CsamReport" ("userId", images) VALUES (NULL, '[{"id": 4}]');
  `);
  await db.exec(`INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (5, ${CAPTURE})`);
});

beforeEach(async () => {
  await db.exec('BEGIN');
});
afterEach(async () => {
  await db.exec('ROLLBACK');
});

const present = async (id: number) =>
  (await db.query(`SELECT 1 FROM "Image" WHERE id = $1`, [id])).rows.length === 1;

describe('the image delete trigger', () => {
  it.each([
    ['under review', 1],
    ['blocked', 2],
    ['flagged minor', 3],
    ['listed on a report', 4],
    ['already kept by an evidence hold', 5],
  ])('keeps a capture %s', async (_label, id) => {
    await db.exec(`DELETE FROM "Image" WHERE id = ${id}`);
    expect(await present(id)).toBe(true);
    expect(
      (await db.query(`SELECT 1 FROM "EvidenceHoldImage" WHERE "imageId" = $1`, [id])).rows
    ).toHaveLength(1);
  });

  it('deletes a capture nothing keeps', async () => {
    await db.exec(`DELETE FROM "Image" WHERE id = 6`);
    expect(await present(6)).toBe(false);
  });

  // The applied trigger holds only a marked owner's images; this migration must not widen that.
  it('still deletes an unmarked owner’s image under review, and keeps a marked owner’s', async () => {
    await db.exec(`DELETE FROM "Image" WHERE id IN (10, 11, 12)`);
    expect(await present(10)).toBe(false);
    expect(await present(11)).toBe(false);
    expect(await present(12)).toBe(true);
  });

  it('keeps exactly what captureImageHeldSql keeps', async () => {
    const app = captureImageHeldSql('i');
    expect(app.values).toEqual([]);
    const { rows } = await db.query<{ id: number; fn: boolean; app: boolean }>(
      `SELECT i.id, evidence_hold_capture_held(i.id, i."needsReview", i."blockedFor", i.minor) AS fn,
         ${app.text} AS app
       FROM "Image" i WHERE i."userId" = $1 ORDER BY i.id`,
      [CAPTURE]
    );
    expect(rows.filter((r) => r.fn !== r.app)).toEqual([]);
    expect(rows.filter((r) => r.fn).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('20261231120100_feedback_capture_owner_hold', () => {
  const body = (sql: string) => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION evidence_hold_keep_image()');
    const end = sql.indexOf('$$ LANGUAGE plpgsql', start);
    return sql.slice(start, end);
  };

  // Written against the applied trigger, never against main's unapplied 20261227150000 functions.
  it('names nothing from the unapplied owner-held migration', () => {
    expect(CAPTURE_MIGRATION).not.toMatch(/owner_held/);
  });

  it('changes the applied trigger function only by the capture clause', () => {
    const ours = body(CAPTURE_MIGRATION).replace(
      /\n\s*OR \(OLD\."userId" = -2\n\s*AND evidence_hold_capture_held\([^)]*\)\)/,
      ''
    );
    expect(ours).toBe(body(LIVE_KEEP_IMAGE));
  });
});
