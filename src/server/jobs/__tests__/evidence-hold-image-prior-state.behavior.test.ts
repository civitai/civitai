import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The hold's Image delete trigger records what a kept image was before it blocked it. Runs both
 * real migrations on PGlite.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const HOLD_MIGRATION = `${MIGRATIONS}/20261019220000_evidence_hold/migration.sql`;
const PRIOR_STATE_MIGRATION = `${MIGRATIONS}/20261204120000_evidence_hold_image_prior_state/migration.sql`;

const HELD_USER = 1;
const PLAIN_USER = 2;

const SCANNED = 10; // live on the site
const TOS = 11; // already blocked by a moderator
const GRACED = 12; // blocked by an account-deletion grace block, prior state in metadata
const UNHELD = 13;
const HIDDEN = 14; // a live image the grace block hid
const POST = 500;

// The tables the hold migration's triggers attach to, as far as these cases need them.
const BASE_SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    url text NOT NULL DEFAULT 'u',
    "postId" int,
    "nsfwLevel" int NOT NULL DEFAULT 0,
    ingestion "ImageIngestionStatus" NOT NULL,
    "needsReview" text,
    "blockedFor" text,
    metadata jsonb,
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

type Prior = {
  priorIngestion: string | null;
  priorBlockedFor: string | null;
  priorNsfwLevel: number | null;
};

async function priorOf(imageId: number) {
  const { rows } = await db.query<Prior>(
    `SELECT "priorIngestion", "priorBlockedFor", "priorNsfwLevel" FROM "EvidenceHoldImage" WHERE "imageId" = $1`,
    [imageId]
  );
  return rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(readFileSync(HOLD_MIGRATION, 'utf8'));
  await db.exec(readFileSync(PRIOR_STATE_MIGRATION, 'utf8'));
  await db.exec(`
    INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${HELD_USER}, 'manual', 'test');
    INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel", ingestion, "blockedFor", metadata) VALUES
      (${SCANNED}, ${HELD_USER}, ${POST}, 4, 'Scanned', NULL, '{}'),
      (${TOS}, ${HELD_USER}, NULL, 16, 'Blocked', 'tos', '{}'),
      -- The grace block's two shapes (remove-deleted-user-images.ts): a repointed AiNotVerified
      -- block keeps its nsfwLevel; a hidden live image is set to the blocked level, its block
      -- reason unrecorded.
      (${GRACED}, ${HELD_USER}, NULL, 8, 'Blocked', 'moderated',
        '{"accountDeletionPriorIngestion": "Blocked", "accountDeletionPriorBlockedFor": "AiNotVerified"}'),
      (${HIDDEN}, ${HELD_USER}, NULL, 32, 'Blocked', 'moderated',
        '{"accountDeletionPriorIngestion": "Scanned"}'),
      (${UNHELD}, ${PLAIN_USER}, NULL, 4, 'Scanned', NULL, '{}');
    DELETE FROM "Image" WHERE id IN (${SCANNED}, ${TOS}, ${GRACED}, ${HIDDEN}, ${UNHELD});
  `);
});

describe('a kept image records what it was', () => {
  it('a live image: its ingestion, no block reason, and its nsfwLevel', async () => {
    expect(await priorOf(SCANNED)).toEqual({
      priorIngestion: 'Scanned',
      priorBlockedFor: null,
      priorNsfwLevel: 4,
    });
    const { rows } = await db.query(
      `SELECT ingestion, "blockedFor", "nsfwLevel", "postId" FROM "Image" WHERE id = ${SCANNED}`
    );
    expect(rows).toEqual([
      { ingestion: 'Blocked', blockedFor: 'moderated', nsfwLevel: 32, postId: null },
    ]);
    const kept = await db.query(
      `SELECT "postId" FROM "EvidenceHoldImage" WHERE "imageId" = ${SCANNED}`
    );
    expect(kept.rows).toEqual([{ postId: POST }]);
  });

  it('an image a moderator already blocked: that block', async () => {
    expect(await priorOf(TOS)).toEqual({
      priorIngestion: 'Blocked',
      priorBlockedFor: 'tos',
      priorNsfwLevel: 16,
    });
  });

  it('a repointed grace block: the block the grace block recorded', async () => {
    expect(await priorOf(GRACED)).toEqual({
      priorIngestion: 'Blocked',
      priorBlockedFor: 'AiNotVerified',
      priorNsfwLevel: 8,
    });
  });

  it('an image the grace block hid: its ingestion, and no block reason', async () => {
    expect(await priorOf(HIDDEN)).toEqual({
      priorIngestion: 'Scanned',
      priorBlockedFor: null,
      priorNsfwLevel: 32,
    });
  });

  it('a second delete leaves the first record', async () => {
    await db.exec(`DELETE FROM "Image" WHERE id = ${SCANNED}`);
    expect((await priorOf(SCANNED))?.priorIngestion).toBe('Scanned');
  });

  it('an unheld owner’s image is deleted and records nothing', async () => {
    expect((await db.query(`SELECT 1 FROM "Image" WHERE id = ${UNHELD}`)).rows).toEqual([]);
    expect(await priorOf(UNHELD)).toBeUndefined();
  });
});
