-- Crucible: the two video-only setup options — how long a judge must watch each clip before
-- either vote unlocks, and how long a submitted clip may be.
--
-- Idempotent, like 20260914120000_crucible: these environments are updated by hand rather than by
-- `prisma migrate deploy`, so re-applying has to be a safe no-op.

ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "minViewSeconds" INTEGER;
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "maxClipSeconds" INTEGER;

-- A crucible takes one media type, so these settings are meaningless on an image crucible and
-- NULL is the only value that reads as "no rule". Without this an image crucible could carry a
-- stale video rule that no application code would ever surface.
DO $$ BEGIN
  ALTER TABLE "Crucible" ADD CONSTRAINT "Crucible_video_settings_require_video" CHECK (
    "contentType" = 'video'
    OR ("minViewSeconds" IS NULL AND "maxClipSeconds" IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
