CREATE OR REPLACE FUNCTION publish_post_metrics()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."publishedAt" IS NOT NULL AND NEW."publishedAt" <= now() AND OLD."publishedAt" IS NULL THEN
    -- Post was published
    INSERT INTO "PostMetric" ("postId", "timeframe", "createdAt", "updatedAt", "likeCount", "dislikeCount", "laughCount", "cryCount", "heartCount", "commentCount", "collectedCount", "ageGroup")
    VALUES
      (NEW."id", 'Day'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, 'Day'::"MetricTimeframe"),
      (NEW."id", 'Week'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, 'Day'::"MetricTimeframe"),
      (NEW."id", 'Month'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, 'Day'::"MetricTimeframe"),
      (NEW."id", 'Year'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, 'Day'::"MetricTimeframe"),
      (NEW."id", 'AllTime'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, 'Day'::"MetricTimeframe")
    ON CONFLICT ("postId", "timeframe") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER publish_post_metrics_trigger
AFTER UPDATE OF "publishedAt" ON "Post"
FOR EACH ROW
EXECUTE FUNCTION publish_post_metrics();
