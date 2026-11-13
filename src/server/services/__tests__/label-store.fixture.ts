import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';

export const LABEL_STORE_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261103120000_label_store/migration.sql'
);

/** A hand-written subset of the site tables the label store hooks into. */
const SOURCE_TABLES = `
  CREATE TABLE "Image" (
    "id" integer PRIMARY KEY,
    "userId" integer NOT NULL,
    "url" text NOT NULL,
    "pHash" bigint,
    "meta" jsonb,
    "needsReview" text,
    "blockedFor" text
  );
  CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
  CREATE TABLE "Appeal" ("id" serial PRIMARY KEY, "userId" integer NOT NULL);
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
`;

export async function bootLabelStore(db: PGlite) {
  await db.exec(SOURCE_TABLES);
  await db.exec(readFileSync(LABEL_STORE_MIGRATION, 'utf8'));
}
