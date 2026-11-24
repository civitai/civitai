-- A post its delete keeps for a review is unpublished with unpublishedReason 'pending-delete'
-- (deleteStatement in packages/civitai-db-queries/src/content-deletion.db.ts). Several paths can
-- publish a post (the owner's edit, scheduled publishing, a model publish sweeping its posts), so the
-- table refuses it while the post's delete is still queued: such a post stays unpublished, its stamp
-- (or the reason a moderator unpublished it for) intact. Silent rather than an error, so a bulk publish still publishes the other posts. Once the
-- queued delete is gone without the post (an account restore releases it), a publish goes through
-- and drops the stamp.
--
-- Additive and idempotent: no data changes. Hand-applied.

CREATE OR REPLACE FUNCTION post_pending_delete_keep_unpublished() RETURNS trigger AS $$
BEGIN
  -- Only a post unpublished for a reason (this delete's, or a moderator's before it) is checked.
  IF NEW."publishedAt" IS NULL OR OLD."metadata" ->> 'unpublishedReason' IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "JobQueue"
    WHERE "entityType" = 'Post' AND "entityId" = OLD.id AND type = 'PendingDelete'
  ) THEN
    NEW."publishedAt" := NULL;
    NEW."metadata" := COALESCE(NEW."metadata", '{}'::jsonb) || jsonb_build_object(
      'unpublishedAt', OLD."metadata" -> 'unpublishedAt',
      'unpublishedBy', OLD."metadata" -> 'unpublishedBy',
      'unpublishedReason', OLD."metadata" -> 'unpublishedReason',
      'prevPublishedAt', OLD."metadata" -> 'prevPublishedAt'
    );
  ELSIF NEW."metadata" ->> 'unpublishedReason' = 'pending-delete' THEN
    NEW."metadata" := NEW."metadata" - 'unpublishedAt' - 'unpublishedBy' - 'unpublishedReason' - 'prevPublishedAt';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_post_pending_delete_keep_unpublished ON "Post";
CREATE TRIGGER trg_post_pending_delete_keep_unpublished
  BEFORE UPDATE OF "publishedAt" ON "Post"
  FOR EACH ROW
  EXECUTE FUNCTION post_pending_delete_keep_unpublished();
