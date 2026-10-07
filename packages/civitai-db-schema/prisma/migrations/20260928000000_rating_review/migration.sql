-- RatingReview: one owner-dispute queue for every rated entity; ArticleRatingReview's rows are copied in.
-- Apply by hand to an environment BEFORE the feat/text-scan build that carries plan 05 runs there, then
-- RE-RUN in prod once the main app and apps/moderator releases of feat/text-scan are both live. Every
-- statement is idempotent; the re-run picks up disputes filed or resolved on ArticleRatingReview while the
-- old code was still live.

CREATE TABLE IF NOT EXISTS "RatingReview" (
  "id" SERIAL PRIMARY KEY,
  "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "currentLevel" INTEGER NOT NULL,
  "suggestedLevel" INTEGER NOT NULL,
  "appliedLevel" INTEGER,
  "userComment" TEXT,
  "modComment" TEXT,
  "status" "ReportStatus" NOT NULL DEFAULT 'Pending',
  "resolvedBy" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  "resolvedTextHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "RatingReview_status_createdAt_idx" ON "RatingReview" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "RatingReview_userId_idx" ON "RatingReview" ("userId");
CREATE INDEX IF NOT EXISTS "RatingReview_entityType_entityId_createdAt_idx"
  ON "RatingReview" ("entityType", "entityId", "createdAt" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "RatingReview_pending_per_entity"
  ON "RatingReview" ("entityType", "entityId") WHERE "status" = 'Pending';

-- Adding a foreign key locks "User" against writes while it is taken; time out rather than queue.
SET lock_timeout = '3s';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RatingReview_userId_fkey') THEN
    ALTER TABLE "RatingReview" ADD CONSTRAINT "RatingReview_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RatingReview_resolvedBy_fkey') THEN
    ALTER TABLE "RatingReview" ADD CONSTRAINT "RatingReview_resolvedBy_fkey"
      FOREIGN KEY ("resolvedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
RESET lock_timeout;

-- Rows match on (articleId, userId, createdAt), never on id: ArticleRatingReview keeps issuing ids from
-- its own sequence until the old code is gone, and those would collide with RatingReview's.
INSERT INTO "RatingReview" (
  "entityType", "entityId", "userId", "currentLevel", "suggestedLevel", "appliedLevel",
  "userComment", "modComment", "status", "resolvedBy", "resolvedAt", "createdAt"
)
SELECT
  'Article', arr."articleId", arr."userId", arr."currentLevel", arr."suggestedLevel", arr."appliedLevel",
  arr."userComment", arr."modComment", arr."status", arr."resolvedBy", arr."resolvedAt", arr."createdAt"
FROM "ArticleRatingReview" arr
WHERE NOT EXISTS (
    SELECT 1 FROM "RatingReview" rr
    WHERE rr."entityType" = 'Article' AND rr."entityId" = arr."articleId"
      AND rr."userId" = arr."userId" AND rr."createdAt" = arr."createdAt"
  )
  AND (
    arr."status" <> 'Pending'
    OR NOT EXISTS (
      SELECT 1 FROM "RatingReview" p
      WHERE p."entityType" = 'Article' AND p."entityId" = arr."articleId" AND p."status" = 'Pending'
    )
  );

UPDATE "RatingReview" rr
SET "status" = arr."status",
    "appliedLevel" = arr."appliedLevel",
    "modComment" = arr."modComment",
    "resolvedBy" = arr."resolvedBy",
    "resolvedAt" = arr."resolvedAt"
FROM "ArticleRatingReview" arr
WHERE rr."entityType" = 'Article' AND rr."entityId" = arr."articleId"
  AND rr."userId" = arr."userId" AND rr."createdAt" = arr."createdAt"
  AND rr."status" = 'Pending' AND arr."status" <> 'Pending';

-- Only an explicit /articles/ratings row is copied: /articles has children, so it is a nav section and
-- never holds a grant of its own.
INSERT INTO "AppPageAccess" ("app", "path", "roles", "updatedById", "updatedAt")
SELECT src."app", '/ratings', src."roles", src."updatedById", now()
FROM "AppPageAccess" src
WHERE src."app" = 'moderator' AND src."path" = '/articles/ratings'
ON CONFLICT ("app", "path") DO NOTHING;

-- Anything listed here was NOT copied: a Pending old-table dispute on an article that already has a Pending
-- RatingReview. Resolve it by hand (or leave it; the new row is the one the queue shows).
SELECT arr."id" AS "articleRatingReviewId", arr."articleId", arr."userId", arr."createdAt"
FROM "ArticleRatingReview" arr
WHERE NOT EXISTS (
  SELECT 1 FROM "RatingReview" rr
  WHERE rr."entityType" = 'Article' AND rr."entityId" = arr."articleId"
    AND rr."userId" = arr."userId" AND rr."createdAt" = arr."createdAt"
);

-- Anything listed here was resolved in BOTH queues with different outcomes during the cutover. The article
-- carries whichever resolution wrote last; a moderator decides which stands and re-applies it on /ratings.
SELECT arr."id" AS "articleRatingReviewId", rr."id" AS "ratingReviewId", arr."articleId",
       arr."appliedLevel" AS "oldAppliedLevel", rr."appliedLevel" AS "newAppliedLevel"
FROM "ArticleRatingReview" arr
JOIN "RatingReview" rr
  ON rr."entityType" = 'Article' AND rr."entityId" = arr."articleId"
 AND rr."userId" = arr."userId" AND rr."createdAt" = arr."createdAt"
WHERE arr."status" <> 'Pending' AND rr."status" <> 'Pending'
  AND arr."appliedLevel" IS DISTINCT FROM rr."appliedLevel";
