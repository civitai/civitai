CREATE OR REPLACE FUNCTION add_image_metrics()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO "ImageMetric" ("imageId", timeframe, "createdAt")
    SELECT
      NEW.id,
      timeframe,
      NEW."createdAt"
    FROM (
      SELECT UNNEST(ENUM_RANGE(NULL::"MetricTimeframe")) AS timeframe
    ) tf(timeframe);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER add_metrics_after_insert
AFTER INSERT ON "Image"
FOR EACH ROW
EXECUTE FUNCTION add_image_metrics();
---
CREATE OR REPLACE FUNCTION add_model_metrics()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO "ModelMetric" ("modelId", timeframe, "updatedAt")
    SELECT
      NEW.id,
      timeframe,
      NEW."createdAt"
    FROM (
      SELECT UNNEST(ENUM_RANGE(NULL::"MetricTimeframe")) AS timeframe
    ) tf(timeframe);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER add_metrics_after_insert
AFTER INSERT ON "Model"
FOR EACH ROW
EXECUTE FUNCTION add_model_metrics();
