/**
 * Adds the columns `deleteImageRows` / `deletePostRows` return to PGlite "Image"/"Post" stand-ins
 * that omit them. Run after the schema's own tables.
 */
export const DELETED_ROW_COLUMNS_SQL = `
DO $$ BEGIN
  IF to_regclass('"Image"') IS NOT NULL THEN
    ALTER TABLE "Image"
      ADD COLUMN IF NOT EXISTS url text,
      ADD COLUMN IF NOT EXISTS "userId" int,
      ADD COLUMN IF NOT EXISTS "postId" int,
      ADD COLUMN IF NOT EXISTS "nsfwLevel" int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS ingestion text,
      ADD COLUMN IF NOT EXISTS "needsReview" text,
      ADD COLUMN IF NOT EXISTS "blockedFor" text,
      ADD COLUMN IF NOT EXISTS metadata jsonb;
  END IF;
  IF to_regclass('"Post"') IS NOT NULL THEN
    ALTER TABLE "Post"
      ADD COLUMN IF NOT EXISTS "userId" int,
      ADD COLUMN IF NOT EXISTS "nsfwLevel" int NOT NULL DEFAULT 0;
  END IF;
END $$;
`;
