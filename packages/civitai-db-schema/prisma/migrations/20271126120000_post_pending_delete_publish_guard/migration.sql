-- A post its delete keeps for a review is unpublished with unpublishedReason 'pending-delete'
-- (deleteStatement in packages/civitai-db-queries/src/content-deletion.db.ts). Several paths can
-- publish a post (the owner's edit, scheduled publishing, a model publish sweeping its posts), so the
-- table refuses it: such a post stays unpublished, its stamp intact, until its queued delete removes
-- the row or a moderator clears the stamp. Silent rather than an error, so a bulk publish still
-- publishes the other posts.
--
-- Additive and idempotent: no data changes. Hand-applied.

CREATE OR REPLACE FUNCTION post_pending_delete_keep_unpublished() RETURNS trigger AS $$
BEGIN
  IF OLD."metadata" ->> 'unpublishedReason' = 'pending-delete' AND NEW."publishedAt" IS NOT NULL THEN
    NEW."publishedAt" := NULL;
    NEW."metadata" := COALESCE(NEW."metadata", '{}'::jsonb) || jsonb_build_object(
      'unpublishedAt', OLD."metadata" -> 'unpublishedAt',
      'unpublishedBy', OLD."metadata" -> 'unpublishedBy',
      'unpublishedReason', OLD."metadata" -> 'unpublishedReason',
      'prevPublishedAt', OLD."metadata" -> 'prevPublishedAt'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_post_pending_delete_keep_unpublished ON "Post";
CREATE TRIGGER trg_post_pending_delete_keep_unpublished
  BEFORE UPDATE OF "publishedAt" ON "Post"
  FOR EACH ROW
  EXECUTE FUNCTION post_pending_delete_keep_unpublished();
