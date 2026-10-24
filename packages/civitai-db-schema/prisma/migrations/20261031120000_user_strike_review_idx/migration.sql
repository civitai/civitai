-- Accounts waiting on a moderator's strike review (User.meta.strikeFlaggedForReview, still muted, not
-- banned or deleted). The moderator app's Strike Review queue and its sidebar badge read this set;
-- without the index each read filters every muted account.
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. Apply per environment (dev, then prod).
-- Additive; the queue is correct without it, only slow.
--
-- The predicate must match the queue query text exactly (`inQueue` in
-- apps/moderator/src/lib/server/strike-review.service.ts) for the planner to use it.
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "User_strikeReview_idx", then re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_strikeReview_idx"
  ON "User" (id)
  WHERE (meta->>'strikeFlaggedForReview')::boolean IS TRUE
    AND "bannedAt" IS NULL
    AND "deletedAt" IS NULL
    AND muted = true;
