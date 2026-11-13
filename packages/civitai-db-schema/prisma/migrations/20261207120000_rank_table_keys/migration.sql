-- The metrics job now syncs ArticleRank and BountyRank in place (upsert on the primary key)
-- instead of recreating them, so the tables, their primary keys and the listing index must
-- already exist. Earlier migrations created ArticleRank without a key and never created
-- BountyRank; the old job built both. Every statement is a no-op where they already exist.

CREATE TABLE IF NOT EXISTS "BountyRank" AS SELECT * FROM "BountyRank_Live";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ArticleRank"'::regclass AND contype = 'p') THEN
    ALTER TABLE "ArticleRank" ADD CONSTRAINT "pk_ArticleRank" PRIMARY KEY ("articleId");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"BountyRank"'::regclass AND contype = 'p') THEN
    ALTER TABLE "BountyRank" ADD CONSTRAINT "pk_BountyRank" PRIMARY KEY ("bountyId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ArticleRank_reactionCountMonthRank_idx" ON "ArticleRank" ("reactionCountMonthRank");
