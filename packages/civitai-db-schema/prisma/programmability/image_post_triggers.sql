CREATE OR REPLACE FUNCTION update_image_sort_at()
  RETURNS TRIGGER AS
$$
BEGIN
  UPDATE "Image" SET "updatedAt" = now() WHERE "postId" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER post_published_at_change
  AFTER UPDATE OF "publishedAt"
  ON "Post"
  FOR EACH ROW
EXECUTE FUNCTION update_image_sort_at();
