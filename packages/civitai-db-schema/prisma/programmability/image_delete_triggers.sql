CREATE OR REPLACE FUNCTION after_image_delete()
RETURNS TRIGGER AS
$$
BEGIN
  DELETE FROM "TagsOnImageNew" WHERE "imageId" = OLD.id;
  RETURN OLD;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER after_image_delete_trigger
AFTER DELETE ON "Image"
FOR EACH ROW
EXECUTE FUNCTION after_image_delete();