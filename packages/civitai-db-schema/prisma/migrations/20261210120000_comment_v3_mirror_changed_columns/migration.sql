-- Comments v3, Phase 4 stage B (docs/plans/comments-v3-article-flip.md). Apply before the stage B
-- deploy, with `psql -v ON_ERROR_STOP=1 -f migration.sql`, as the role that owns the mirror functions.
--
-- Once a surface writes CommentV3 directly, its comments that started in CommentV2 are edited in
-- CommentV3 only, and their CommentV2 rows go stale. An old-table update of one of those rows (a
-- moderation path, a direct SQL fix) must not overwrite the newer CommentV3 content, so the update
-- copies only the columns the statement changed. Nothing else in the mirror changes.

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION commentv3_mirror_v2_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM commentv3_mirror_v2(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only a deleter (FOR UPDATE) is skipped. The UPDATE below waits for NO KEY UPDATE holders
    -- (reaction count, lock toggle, replyToId SET NULL) instead of dropping the edit.
    PERFORM 1 FROM "CommentV3" WHERE id = NEW.id FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN
      -- Possibly mid-copy in another transaction: our copy waits for its commit and then no-ops, so
      -- NEW is applied below.
      PERFORM commentv3_mirror_v2(NEW);
      PERFORM 1 FROM "CommentV3" WHERE id = NEW.id FOR KEY SHARE SKIP LOCKED;
    END IF;
    IF FOUND THEN
      UPDATE "CommentV3" v
         SET content        = CASE WHEN NEW.content IS DISTINCT FROM OLD.content
                                   THEN NEW.content ELSE v.content END,
             "updatedAt"    = CASE WHEN NEW."updatedAt" IS DISTINCT FROM OLD."updatedAt"
                                   THEN NEW."updatedAt" AT TIME ZONE 'UTC' ELSE v."updatedAt" END,
             "tosViolation" = CASE WHEN NEW."tosViolation" IS DISTINCT FROM OLD."tosViolation"
                                   THEN NEW."tosViolation" ELSE v."tosViolation" END,
             hidden         = CASE WHEN NEW.hidden IS DISTINCT FROM OLD.hidden
                                   THEN COALESCE(NEW.hidden, false) ELSE v.hidden END,
             "pinnedAt"     = CASE WHEN NEW."pinnedAt" IS DISTINCT FROM OLD."pinnedAt"
                                   THEN NEW."pinnedAt" AT TIME ZONE 'UTC' ELSE v."pinnedAt" END
       WHERE v.id = NEW.id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM commentv3_mirror_delete(OLD.id);
  END IF;
  RETURN NULL;
END $$;

COMMIT;
