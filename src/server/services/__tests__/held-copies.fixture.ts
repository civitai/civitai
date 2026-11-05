import { readFileSync } from 'fs';
import path from 'path';

const migrationPath = (name: string) =>
  path.resolve(
    __dirname,
    `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
  );
const HELD_COPIES_MIGRATION = migrationPath('20261212120000_held_resource_review');
const HELD_STORYLINE_COPIES_MIGRATIONS = [
  '20261216130000_storyline_held_chapter',
  '20261222120000_held_storyline',
].map(migrationPath);

/**
 * The held-copy tables, and the columns their copies read on a fixture's own "ResourceReview" and
 * "ModelVersion": a parent DELETE copies a held author's rows in the same statement, so a fixture
 * that deletes a model or version needs them, whether or not it seeds any.
 */
export const heldCopiesSchemaSql = () => `
  CREATE TABLE IF NOT EXISTS "ResourceReview" (id serial PRIMARY KEY);
  ALTER TABLE "ResourceReview"
    ADD COLUMN IF NOT EXISTS "userId" int,
    ADD COLUMN IF NOT EXISTS "modelId" int,
    ADD COLUMN IF NOT EXISTS "modelVersionId" int,
    ADD COLUMN IF NOT EXISTS rating int NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS recommended boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS details text,
    ADD COLUMN IF NOT EXISTS exclude boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS nsfw boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "tosViolation" boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS metadata jsonb,
    ADD COLUMN IF NOT EXISTS "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS "updatedAt" timestamp(3) NOT NULL DEFAULT now();
  CREATE TABLE IF NOT EXISTS "ModelVersion" (id serial PRIMARY KEY);
  ALTER TABLE "ModelVersion" ADD COLUMN IF NOT EXISTS "modelId" int;
  ${readFileSync(HELD_COPIES_MIGRATION, 'utf8')}
`;

/**
 * The held storyline copy tables, which `purgeReleasedHeldCopies` reads, with stand-ins for what
 * their migrations alter or index when a fixture has no storyline tables of its own.
 */
export const heldStorylineCopiesSchemaSql = () => `
  DO $$ BEGIN
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS "Report" (id int PRIMARY KEY, status "ReportStatus" NOT NULL DEFAULT 'Pending');
  CREATE TABLE IF NOT EXISTS "Storyline" (id int PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS "StorylineBranchChoice" ("chapterId" int);
  CREATE TABLE IF NOT EXISTS "StorylineReport" ("storylineId" int NOT NULL, "reportId" int NOT NULL,
    CONSTRAINT "StorylineReport_pkey" PRIMARY KEY ("reportId", "storylineId"));
  CREATE UNIQUE INDEX IF NOT EXISTS "StorylineReport_reportId_key" ON "StorylineReport" ("reportId");
  ${HELD_STORYLINE_COPIES_MIGRATIONS.map((m) => readFileSync(m, 'utf8')).join('\n')}
`;
