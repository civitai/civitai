-- Copyright strikes per account, for the moderator app's repeat-infringer queue
-- (apps/moderator/src/lib/server/repeat-infringer.service.ts), which groups them by user inside a window.
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. Apply per environment (dev, then prod).
-- Additive; the queue is correct without it, only slower.
--
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "UserStrike_copyright_user_created_idx", then re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserStrike_copyright_user_created_idx"
  ON "UserStrike" ("userId", "createdAt")
  WHERE reason = 'Copyright';
