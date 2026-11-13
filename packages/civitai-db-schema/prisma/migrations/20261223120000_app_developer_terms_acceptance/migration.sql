-- App Developer Terms acceptance: one row per (developer, terms version), written when a developer
-- ticks "I accept the App Developer Terms" at app publish. Every developer submit path refuses
-- until the current version has a row for the acting user.
--
-- MANUAL APPLY, per environment, BEFORE the deploy that reads it: once deployed, every app
-- submission reads this table, and a missing table refuses them all. New table only, nothing
-- existing changes. Re-runnable.
SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "app_developer_terms_acceptances" (
  "user_id" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "version" TEXT NOT NULL,
  "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "app_developer_terms_acceptances_pkey" PRIMARY KEY ("user_id", "version")
);
