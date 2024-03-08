CREATE OR REPLACE FUNCTION update_image_nsfw_level()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."nsfwLevel" != OLD."nsfwLevel" THEN
    INSERT INTO "NsfwLevelUpdateQueue" ("entityId", "entityType")
    VALUES (NEW.id, 'Image')
    ON CONFLICT ("entityId", "entityType") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER image_nsfw_level_change
AFTER UPDATE OF "nsfwLevel" ON "Image"
FOR EACH ROW
EXECUTE FUNCTION update_image_nsfw_level();
