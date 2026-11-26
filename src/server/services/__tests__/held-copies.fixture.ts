import { readFileSync } from 'fs';
import path from 'path';

const migrationPath = (name: string) =>
  path.resolve(
    __dirname,
    `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
  );
const HELD_STORYLINE_COPIES_MIGRATIONS = [
  '20261216130000_storyline_held_chapter',
  '20261222120000_held_storyline',
].map(migrationPath);

/**
 * The held storyline copy tables, which the storyline delete writes, with stand-ins for what
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
