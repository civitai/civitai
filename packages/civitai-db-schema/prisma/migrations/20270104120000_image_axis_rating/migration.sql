-- Rating axes of an image (sexual, violence, language) from an axis-capable rater, or a moderator.
-- Additive: a new type and a new empty table; "Image" itself is not altered.
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
  )
);

-- NOT VALID then VALIDATE: the lock on "Image" is held only for the brief catalog change.
ALTER TABLE "ImageAxisRating" ADD CONSTRAINT "ImageAxisRating_imageId_fkey"
  FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ImageAxisRating" VALIDATE CONSTRAINT "ImageAxisRating_imageId_fkey";

-- Migration-only: Prisma does not model partial indexes.
CREATE INDEX "ImageAxisRating_rated_idx" ON "ImageAxisRating" ("imageId") WHERE "source" = 'rated';
