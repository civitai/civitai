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
    INSERT INTO "Image" (id, "userId", "nsfwLevel", ingestion, "blockedFor", metadata) VALUES
      (${SCANNED}, ${HELD_USER}, 4, 'Scanned', NULL, '{}'),
      (${TOS}, ${HELD_USER}, 16, 'Blocked', 'tos', '{}'),
      (${GRACED}, ${HELD_USER}, 32, 'Blocked', 'moderated',
        '{"accountDeletionPriorIngestion": "Pending", "accountDeletionPriorBlockedFor": "AiNotVerified"}'),
      (${UNHELD}, ${PLAIN_USER}, 4, 'Scanned', NULL, '{}');
    DELETE FROM "Image" WHERE id IN (${SCANNED}, ${TOS}, ${GRACED}, ${UNHELD});
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
      `SELECT ingestion, "blockedFor", "nsfwLevel" FROM "Image" WHERE id = ${SCANNED}`
    );
    expect(rows).toEqual([{ ingestion: 'Blocked', blockedFor: 'moderated', nsfwLevel: 32 }]);
  });

  it('an image a moderator already blocked: that block', async () => {
    expect(await priorOf(TOS)).toEqual({
      priorIngestion: 'Blocked',
      priorBlockedFor: 'tos',
      priorNsfwLevel: 16,
    });
  });

  it('an account-deletion grace block: the state the grace block recorded', async () => {
    expect(await priorOf(GRACED)).toEqual({
      priorIngestion: 'Pending',
      priorBlockedFor: 'AiNotVerified',
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
