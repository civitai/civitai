-- When a comment's `hidden` last became true. Nullable, no default, no backfill: rows hidden
-- before this column existed keep NULL. Apply BEFORE deploying the code that writes it.
ALTER TABLE "CommentV3" ADD COLUMN IF NOT EXISTS "hiddenAt" TIMESTAMPTZ(6);
