import { readFileSync } from 'fs';
import path from 'path';

const HELD_COPIES_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261212120000_held_resource_review/migration.sql'
);

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
