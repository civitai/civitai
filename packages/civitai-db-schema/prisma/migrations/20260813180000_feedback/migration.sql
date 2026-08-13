-- ============================================================
-- Feedback — in-product free-text feedback, first used by the BitDex feed notice
-- ============================================================
-- One ADDITIVE table. Nothing existing is altered and no existing row is touched.
--
-- ⚠️ MANUAL APPLY. This repo has no `prisma migrate deploy` in any deploy path;
-- a human applies the SQL below per environment (psql / retool). Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone
--
-- Order matters for the feature: apply this BEFORE enabling the
-- `feedback-area-<slug>` Flipt flag. The flag defaults off, so deploying the
-- code first shows nothing and writes nothing; enabling the flag without the
-- table would render the prompt and fail every submit.
--
-- Idempotent: IF NOT EXISTS guards throughout, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "Feedback" (
  "id"        SERIAL      PRIMARY KEY,
  -- Area slug (e.g. 'bitdex-image-feed'). TEXT, not an enum, so adding a
  -- feedback surface needs no migration. Validated against the TS registry at
  -- the API boundary.
  "area"      TEXT        NOT NULL,
  "userId"    INTEGER     NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "message"   TEXT        NOT NULL,
  -- Client-reported context (route, filters, which backend the client believed
  -- served the page). A claim, not evidence.
  "context"   JSONB       NOT NULL DEFAULT '{}',
  "status"    TEXT        NOT NULL DEFAULT 'new',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Feedback_status_check"
    CHECK ("status" IN ('new', 'reviewed', 'actioned', 'dismissed'))
);

-- Triage read: "unhandled feedback for this area, newest first".
CREATE INDEX IF NOT EXISTS "Feedback_area_status_createdAt_idx"
  ON "Feedback" ("area", "status", "createdAt" DESC);
-- Serves the per-user rate-limit count on submit, and a user's own history.
CREATE INDEX IF NOT EXISTS "Feedback_userId_createdAt_idx"
  ON "Feedback" ("userId", "createdAt" DESC);
