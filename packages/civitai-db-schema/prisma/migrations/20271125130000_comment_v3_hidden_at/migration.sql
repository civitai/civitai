-- When a comment's `hidden` last became true. Nullable, no default, no backfill: rows hidden
-- before this column existed keep NULL. Apply BEFORE deploying the code that writes it.
-- Expects 20270101120000_comment_v3_old_table_triggers_off to be applied already.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "CommentV3" ADD COLUMN IF NOT EXISTS "hiddenAt" TIMESTAMPTZ(6);
COMMIT;
