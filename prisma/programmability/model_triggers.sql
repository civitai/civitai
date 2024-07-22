CREATE OR REPLACE FUNCTION update_model_last_version_at()
RETURNS TRIGGER AS $model_last_version_at$
BEGIN
  IF ((NEW.status = 'Published' AND OLD.status != 'Published') OR (NEW."publishedAt" != OLD."publishedAt")) THEN
    UPDATE "Model"
      SET "lastVersionAt" = NEW."publishedAt"
      WHERE id = NEW."modelId"
        AND "lastVersionAt" < NEW."publishedAt";
  END IF;
  RETURN NULL;
END;
$model_last_version_at$ LANGUAGE plpgsql;

-- MODEL VERSION TRIGGER
CREATE OR REPLACE TRIGGER model_last_version_at_change
AFTER UPDATE OF "status", "publishedAt" ON "ModelVersion" -- TODO - on delete model version, queue up cleanup task
FOR EACH ROW
EXECUTE FUNCTION update_model_last_version_at();
