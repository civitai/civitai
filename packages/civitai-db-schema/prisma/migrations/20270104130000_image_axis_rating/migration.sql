-- Rating axes of an image (sexual, violence, language) from an axis-capable rater, or a moderator.
-- Additive: a new type and a new empty table; "Image" itself is not altered.
--
-- ORDER: deploy the release first, with image-axis-shadow-write off; it tolerates the missing table.
-- Apply this, check the grants, then turn the flag on.
--
-- The foreign key locks "Image" briefly. A lock timeout rolls everything back; re-run the file as
-- is, at a quieter moment if it times out again.
--
-- GRANTS, A REQUIRED STEP. Unless new tables are granted to the app roles automatically in this
-- environment, run after this file, with the environment's actual role names:
--   GRANT SELECT, INSERT, UPDATE ON "ImageAxisRating" TO <app_write_role>;
-- and check it with has_table_privilege('<role>', '"ImageAxisRating"', '<privilege>'). The shadow
-- write upserts; nothing reads the table yet. Without the grant every write fails and is only logged.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "ImageAxisSource" AS ENUM ('rated', 'moderator');

CREATE TABLE "ImageAxisRating" (
  "imageId" INTEGER NOT NULL,
  "source" "ImageAxisSource" NOT NULL,
  "sexualLevel" SMALLINT,
  "sexualHighWater" SMALLINT,
  "violenceLevel" SMALLINT,
  "languageLevel" SMALLINT,
  "rater" TEXT,
  "raterVersion" TEXT,
  "ratedAt" TIMESTAMPTZ(3) NOT NULL,
  "workflowId" TEXT,
  "setBy" INTEGER,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageAxisRating_pkey" PRIMARY KEY ("imageId"),
  CONSTRAINT "ImageAxisRating_levels_check" CHECK (
    ("sexualLevel" IS NULL OR "sexualLevel" BETWEEN 0 AND 4)
    AND ("sexualHighWater" IS NULL OR "sexualHighWater" BETWEEN 0 AND 4)
    AND ("violenceLevel" IS NULL OR "violenceLevel" BETWEEN 0 AND 4)
    AND ("languageLevel" IS NULL OR "languageLevel" BETWEEN 0 AND 4)
  ),
  CONSTRAINT "ImageAxisRating_rated_provenance_check" CHECK (
    "source" <> 'rated' OR ("rater" IS NOT NULL AND "raterVersion" IS NOT NULL)
  ),
  CONSTRAINT "ImageAxisRating_high_water_check" CHECK (
    "sexualHighWater" IS NULL OR "sexualLevel" IS NULL OR "sexualHighWater" >= "sexualLevel"
  ),
  CONSTRAINT "ImageAxisRating_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

COMMIT;
