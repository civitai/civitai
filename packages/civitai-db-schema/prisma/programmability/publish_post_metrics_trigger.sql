CREATE OR REPLACE FUNCTION publish_post_metrics()
RETURNS TRIGGER AS $$
DECLARE
  ageGroup "MetricTimeframe";
BEGIN
  -- Determine the age group based on the publishedAt timestamp
  ageGroup := CASE
                WHEN NEW."publishedAt" IS NULL OR NEW."publishedAt" > now() + interval '10 seconds' THEN NULL
                ELSE 'Day'::"MetricTimeframe"
              END;

  -- Insert into PostMetric for different timeframes
  INSERT INTO "PostMetric" ("postId", "timeframe", "createdAt", "updatedAt", "likeCount", "dislikeCount", "laughCount", "cryCount", "heartCount", "commentCount", "collectedCount", "ageGroup")
  VALUES
    -- (NEW."id", 'Day'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup),
    -- (NEW."id", 'Week'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup),
    -- (NEW."id", 'Month'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup),
    -- (NEW."id", 'Year'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup),
    (NEW."id", 'AllTime'::"MetricTimeframe", now(), now(), 0, 0, 0, 0, 0, 0, 0, ageGroup)
  ON CONFLICT ("postId", "timeframe") DO UPDATE SET "ageGroup" = ageGroup;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER publish_post_metrics_trigger
AFTER UPDATE OF "publishedAt" ON "Post"
FOR EACH ROW
WHEN (NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt")
EXECUTE FUNCTION publish_post_metrics();
