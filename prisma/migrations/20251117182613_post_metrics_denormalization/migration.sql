-- Add migration here
ALTER TABLE "Post"
  ADD COLUMN "reactionCount" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "commentCount"  integer DEFAULT 0 NOT NULL,
  ADD COLUMN "collectedCount" integer DEFAULT 0 NOT NULL;

---
CREATE OR REPLACE FUNCTION sync_post_alltime_metrics()
RETURNS trigger AS $$
BEGIN
  -- Only update when the timeframe is AllTime
  IF NEW.timeframe = 'AllTime' THEN
    UPDATE "Post"
    SET
      "reactionCount"  = NEW."reactionCount",
      "commentCount"   = NEW."commentCount",
      "collectedCount" = NEW."collectedCount"
    WHERE id = NEW."postId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE TRIGGER trg_sync_post_alltime_metrics
AFTER INSERT OR UPDATE OF "reactionCount", "commentCount", "collectedCount"
ON "PostMetric"
FOR EACH ROW
EXECUTE FUNCTION sync_post_alltime_metrics();
---

CREATE INDEX CONCURRENTLY post_feed_reaction_idx
  ON "Post" ("publishedAt" DESC, "reactionCount" DESC)
  WHERE "reactionCount" > 0;

CREATE INDEX CONCURRENTLY post_feed_comment_idx
  ON "Post" ("publishedAt" DESC, "commentCount" DESC)
  WHERE "commentCount" > 0;

CREATE INDEX CONCURRENTLY post_feed_collected_idx
  ON "Post" ("publishedAt" DESC, "collectedCount" DESC)
  WHERE "collectedCount" > 0;
