import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The REAL `ArticleRatingReview` and `RatingReview` migrations over stand-in entity tables.
 *
 * The stand-ins carry only the columns the rating-review code reads or writes, including the
 * `moderatorNsfwLevel` + `moderatorNsfwLevelBasis` columns plan 02's migration adds. Seed timestamps as ISO strings, never `Date`:
 * PGlite writes a `Date` as UTC and reads `timestamp without time zone` back as local.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '../../../../../../packages/civitai-db-schema/prisma/migrations');
const migration = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

const PRELUDE = `
CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
CREATE TYPE "ReportReason" AS ENUM ('NSFW', 'TOSViolation');
CREATE TYPE "EntityModerationStatus" AS ENUM ('Pending', 'Succeeded', 'Failed', 'Expired', 'Canceled');
CREATE TYPE "JobQueueType" AS ENUM ('CleanUp', 'UpdateMetrics', 'UpdateNsfwLevel', 'UpdateSearchIndex', 'CleanIfEmpty', 'ModerationRequest', 'BlockedImageDelete', 'ImageScan', 'ReplacedImageDelete');
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Article', 'Bounty', 'BountyEntry', 'ModelVersion', 'Model', 'Collection', 'Comment', 'CommentV2', 'User', 'UserProfile', 'ResourceReview', 'ChatMessage', 'Model3D');

CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "username" TEXT, "image" TEXT);
CREATE TABLE "ModActivity" ("id" SERIAL PRIMARY KEY, "userId" INTEGER, "entityType" TEXT, "entityId" INTEGER, "activity" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "AppPageAccess" ("app" TEXT NOT NULL, "path" TEXT NOT NULL, "roles" TEXT[] NOT NULL, "updatedById" INTEGER, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("app", "path"));
CREATE TABLE "JobQueue" ("type" "JobQueueType" NOT NULL, "entityType" "EntityType" NOT NULL, "entityId" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("entityType", "entityId", "type"));
CREATE TABLE "EntityModeration" ("id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, "status" "EntityModerationStatus" NOT NULL DEFAULT 'Pending', "blocked" BOOLEAN, "triggeredLabels" TEXT[] NOT NULL DEFAULT '{}', "nsfwLevel" INTEGER, "result" JSONB, "contentHash" TEXT, UNIQUE ("entityType", "entityId"));

CREATE TABLE "Image" ("id" SERIAL PRIMARY KEY, "url" TEXT, "type" TEXT, "postId" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "ingestion" TEXT NOT NULL DEFAULT 'Scanned');
CREATE TABLE "ImageConnection" ("imageId" INTEGER NOT NULL, "entityId" INTEGER NOT NULL, "entityType" TEXT NOT NULL);
CREATE TABLE "Report" ("id" SERIAL PRIMARY KEY, "reason" "ReportReason" NOT NULL, "status" "ReportStatus" NOT NULL);
CREATE TABLE "ArticleReport" ("articleId" INTEGER NOT NULL, "reportId" INTEGER NOT NULL);

CREATE TABLE "Article" ("id" SERIAL PRIMARY KEY, "title" TEXT NOT NULL DEFAULT 'a', "userId" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "userNsfwLevel" INTEGER NOT NULL DEFAULT 0, "moderatorNsfwLevel" INTEGER, "moderatorNsfwLevelBasis" INTEGER, "lockedProperties" TEXT[] NOT NULL DEFAULT '{}', "coverId" INTEGER, "cover" TEXT, "updatedAt" TIMESTAMP(3));
CREATE TABLE "Model" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL DEFAULT 'm', "userId" INTEGER, "nsfw" BOOLEAN NOT NULL DEFAULT false, "poi" BOOLEAN NOT NULL DEFAULT false, "minor" BOOLEAN NOT NULL DEFAULT false, "sfwOnly" BOOLEAN NOT NULL DEFAULT false, "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "lockedProperties" TEXT[] NOT NULL DEFAULT '{}', "deletedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3));
CREATE TABLE "ModelVersion" ("id" SERIAL PRIMARY KEY, "modelId" INTEGER NOT NULL);
CREATE TABLE "Post" ("id" SERIAL PRIMARY KEY, "title" TEXT, "userId" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "moderatorNsfwLevel" INTEGER, "moderatorNsfwLevelBasis" INTEGER, "updatedAt" TIMESTAMP(3));
CREATE TABLE "Bounty" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL DEFAULT 'b', "userId" INTEGER, "nsfw" BOOLEAN NOT NULL DEFAULT false, "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "moderatorNsfwLevel" INTEGER, "moderatorNsfwLevelBasis" INTEGER, "lockedProperties" TEXT[] NOT NULL DEFAULT '{}', "updatedAt" TIMESTAMP(3));
CREATE TABLE "BountyEntry" ("id" SERIAL PRIMARY KEY, "bountyId" INTEGER NOT NULL DEFAULT 1, "userId" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "moderatorNsfwLevel" INTEGER, "moderatorNsfwLevelBasis" INTEGER, "updatedAt" TIMESTAMP(3));
CREATE TABLE "Collection" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL DEFAULT 'col', "userId" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "moderatorNsfwLevel" INTEGER, "moderatorNsfwLevelBasis" INTEGER, "metadata" JSONB NOT NULL DEFAULT '{}', "updatedAt" TIMESTAMP(3));
CREATE TABLE "Crucible" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL DEFAULT 'cr', "userId" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 1, "textNsfw" BOOLEAN NOT NULL DEFAULT false, "status" TEXT NOT NULL DEFAULT 'Pending', "startAt" TIMESTAMP(3), "moderatorNsfwLevel" INTEGER, "moderatorNsfwLevelBasis" INTEGER, "updatedAt" TIMESTAMP(3));
CREATE TABLE "Challenge" ("id" SERIAL PRIMARY KEY, "title" TEXT NOT NULL DEFAULT 'ch', "createdById" INTEGER, "source" TEXT NOT NULL DEFAULT 'User', "nsfwLevel" INTEGER NOT NULL DEFAULT 1, "allowedNsfwLevel" INTEGER NOT NULL DEFAULT 1, "moderatorNsfwLevel" INTEGER, "moderatorNsfwLevelBasis" INTEGER, "collectionId" INTEGER, "updatedAt" TIMESTAMP(3));
`;

export async function applyRatingReviewMigration(db: PGlite): Promise<void> {
  await db.exec(migration('20260928000000_rating_review'));
}

/** Prelude + the old table's real migration, WITHOUT the migration under test. */
export async function freshPreMigrationDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(PRELUDE);
  await db.exec(migration('20260522120000_article_rating_review'));
  return db;
}

export async function freshRatingReviewDb(): Promise<PGlite> {
  const db = await freshPreMigrationDb();
  await applyRatingReviewMigration(db);
  return db;
}

export const ratingReviewKysely = (db: PGlite): Kysely<DB> =>
  new Kysely<DB>({ dialect: pgliteDialect(db) });

export async function rows<T>(db: PGlite, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}

export async function countRows(db: PGlite, table: string): Promise<number> {
  const [r] = await rows<{ n: string }>(db, `SELECT count(*)::text AS n FROM "${table}"`);
  return Number(r.n);
}

export async function seedUser(db: PGlite, username: string): Promise<number> {
  const [r] = await rows<{ id: number }>(
    db,
    'INSERT INTO "User" ("username") VALUES ($1) RETURNING "id"',
    [username]
  );
  return r.id;
}

type Row = Record<string, unknown>;

/** Inserts one row into a stand-in table; `updatedAt` defaults to a fixed ISO string. */
export async function seedEntity(db: PGlite, table: string, row: Row): Promise<number> {
  const withDefaults: Row = { updatedAt: '2026-09-01T00:00:00.000Z', ...row };
  const cols = Object.keys(withDefaults);
  const [r] = await rows<{ id: number }>(
    db,
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING "id"`,
    cols.map((c) => withDefaults[c])
  );
  return r.id;
}

export const seedArticle = (db: PGlite, row: Row = {}) => seedEntity(db, 'Article', row);

export async function seedArticleReview(
  db: PGlite,
  row: {
    articleId: number;
    userId: number;
    status?: 'Pending' | 'Actioned' | 'Unactioned';
    createdAt?: string;
    appliedLevel?: number | null;
    resolvedBy?: number | null;
    modComment?: string | null;
  }
): Promise<number> {
  const resolved = row.status && row.status !== 'Pending';
  const [r] = await rows<{ id: number }>(
    db,
    `INSERT INTO "ArticleRatingReview"
       ("articleId", "userId", "currentLevel", "suggestedLevel", "appliedLevel", "status", "createdAt",
        "resolvedAt", "resolvedBy", "modComment")
     VALUES ($1, $2, 4, 2, $3, $4, $5, $6, $7, $8) RETURNING "id"`,
    [
      row.articleId,
      row.userId,
      row.appliedLevel ?? null,
      row.status ?? 'Pending',
      row.createdAt ?? '2026-09-01T10:00:00.000Z',
      resolved ? '2026-09-02T10:00:00.000Z' : null,
      row.resolvedBy ?? null,
      row.modComment ?? null,
    ]
  );
  return r.id;
}

export async function seedEm(
  db: PGlite,
  row: {
    entityType: string;
    entityId: number;
    status?: string;
    triggeredLabels?: string[];
    nsfwLevel?: number | null;
    result?: unknown;
    contentHash?: string | null;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO "EntityModeration" ("entityType", "entityId", "status", "triggeredLabels", "nsfwLevel", "result", "contentHash")
     VALUES ($1, $2, $3::"EntityModerationStatus", $4, $5, $6::jsonb, $7)`,
    [
      row.entityType,
      row.entityId,
      row.status ?? 'Succeeded',
      row.triggeredLabels ?? [],
      row.nsfwLevel === undefined ? 4 : row.nsfwLevel,
      JSON.stringify(row.result === undefined ? { version: 1, labels: {} } : row.result),
      row.contentHash === undefined ? 'hash-a' : row.contentHash,
    ]
  );
}
