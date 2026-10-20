-- Takedown CDN sync: queue image takedowns and restores for the `cdn-access-sync` job, which tells
-- the image server to stop (or resume) serving them.
--
-- Apply in this order, by hand:
--   1. AFTER the deploy that ships the regenerated client (it knows 'CdnAccessSync' and writes none).
--   2. This file. The triggers start queueing immediately; the job drains only with the flag on.
--
-- Write cost on the hot tables: every trigger below is WHEN-filtered at the row level, so an
-- unrelated update pays one boolean check and no function call. A matching row writes one
-- "JobQueue" row (an upsert on its primary key), and reads nothing.
--   - Image: transitions into or out of Blocked (about the rate of trg_blocked_image_delete_queue).
--   - Post: an unpublish of a published post, or a republish of one, that carries the unpublish stamp.
--   - ModActivity: each moderator review/bulkRemove on an image.

-- 1. Enum value. Its own statement: a value added in a transaction cannot be used until it commits.
ALTER TYPE "JobQueueType" ADD VALUE IF NOT EXISTS 'CdnAccessSync';

-- 2. State: what the image server has been told per url.
CREATE TABLE IF NOT EXISTS "ImageCdnAccess" (
  url              text PRIMARY KEY,
  state            text NOT NULL CHECK (state IN ('Denied', 'Retracted')),
  "deniedAt"       timestamp(3) NOT NULL DEFAULT now(),
  "retractedAt"    timestamp(3),
  "lastAssertedAt" timestamp(3) NOT NULL DEFAULT now()
);

-- 3. Queueing. On a repeat, `data.seq` changes, so a drain that read the row before the repeat
-- leaves it in place for the next run instead of deleting it. Existing `data` (a moderator delete's
-- url) is kept.
CREATE OR REPLACE FUNCTION queue_cdn_access_sync(entity_id integer, entity_type text, payload jsonb)
RETURNS void AS $$
BEGIN
  INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
  VALUES (entity_id, entity_type::"EntityType", 'CdnAccessSync'::"JobQueueType",
          COALESCE(payload, '{}'::jsonb) || jsonb_build_object('seq', clock_timestamp()))
  ON CONFLICT ("entityType", "entityId", "type") DO UPDATE
    SET "data" = COALESCE("JobQueue"."data", '{}'::jsonb) || EXCLUDED."data";
END;
$$ LANGUAGE plpgsql;

-- Image and Post: the row's own id, entity type from the trigger argument.
CREATE OR REPLACE FUNCTION cdn_access_enqueue_row()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM queue_cdn_access_sync(NEW.id, TG_ARGV[0], NULL);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ModActivity: the image the activity is about.
CREATE OR REPLACE FUNCTION cdn_access_enqueue_mod_activity()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM queue_cdn_access_sync(NEW."entityId", 'Image', NULL);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 4. Triggers. One transaction, with lock_timeout: CREATE TRIGGER takes a table lock on hot tables,
-- and failing fast behind a long transaction beats blocking every write to them.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_cdn_access_image_insert ON "Image";
CREATE TRIGGER trg_cdn_access_image_insert
  AFTER INSERT ON "Image"
  FOR EACH ROW
  WHEN (NEW.ingestion = 'Blocked' AND NEW."blockedFor" IS DISTINCT FROM 'AiNotVerified')
  EXECUTE FUNCTION cdn_access_enqueue_row('Image');

DROP TRIGGER IF EXISTS trg_cdn_access_image_update ON "Image";
CREATE TRIGGER trg_cdn_access_image_update
  AFTER UPDATE OF ingestion, "blockedFor" ON "Image"
  FOR EACH ROW
  WHEN (
    (OLD.ingestion = 'Blocked') IS DISTINCT FROM (NEW.ingestion = 'Blocked')
    OR (NEW.ingestion = 'Blocked' AND OLD."blockedFor" IS DISTINCT FROM NEW."blockedFor")
  )
  EXECUTE FUNCTION cdn_access_enqueue_row('Image');

-- A first publish carries no stamp and does not fire. `?` on a NULL metadata is NULL, i.e. false.
DROP TRIGGER IF EXISTS trg_cdn_access_post ON "Post";
CREATE TRIGGER trg_cdn_access_post
  AFTER UPDATE OF "publishedAt" ON "Post"
  FOR EACH ROW
  WHEN (
    (OLD."publishedAt" IS NULL) IS DISTINCT FROM (NEW."publishedAt" IS NULL)
    AND (
      (NEW."publishedAt" IS NULL AND NEW.metadata ? 'unpublishedAt')
      OR (OLD."publishedAt" IS NULL AND OLD.metadata ? 'unpublishedAt')
    )
  )
  EXECUTE FUNCTION cdn_access_enqueue_row('Post');

-- Keep the activity list in step with MODERATOR_TAKEDOWN_ACTIVITIES (src/server/jobs/image-ingestion.ts).
DROP TRIGGER IF EXISTS trg_cdn_access_mod_activity ON "ModActivity";
CREATE TRIGGER trg_cdn_access_mod_activity
  AFTER INSERT ON "ModActivity"
  FOR EACH ROW
  WHEN (
    NEW."entityType" = 'image'
    AND NEW."entityId" IS NOT NULL
    AND NEW.activity IN ('review', 'bulkRemove')
  )
  EXECUTE FUNCTION cdn_access_enqueue_mod_activity();

COMMIT;
