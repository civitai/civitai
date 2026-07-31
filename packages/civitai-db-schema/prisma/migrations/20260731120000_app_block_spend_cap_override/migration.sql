-- ============================================================
-- App Blocks — PER-APP generation spend/velocity cap OVERRIDE
-- ============================================================
-- The per-app aggregate generation guardrail (app-spend-cap.service.ts) used to
-- enforce ONE global daily-Buzz + velocity ceiling on EVERY app. Its own header
-- flagged that as the prerequisite for opening App Blocks to non-moderators: a
-- modestly popular app would brush the 120-gens/60s velocity ceiling (~2
-- gens/sec AGGREGATE across all its viewers) and its users would start getting
-- abuse rejections.
--
-- The ceilings are now derived from the app's server-owned `trust_tier`, and
-- these two columns are the moderator ESCAPE HATCH on top of that mapping:
--   - NULL            → no override; use the tier's limit for that field.
--   - a positive int  → REPLACES that one field's limit for this app only.
-- The two fields are independent, and an override may TIGHTEN as well as loosen
-- (clamping one abusive app without demoting its tier, which gates other things
-- too).
--
-- 🔴 PLATFORM-CONTROLLED. Written only by the mod-gated
-- `BlockRegistry.setAppSpendCapOverride` (moderatorProcedure). Never
-- publisher-declared and never read from the app manifest — a developer must not
-- be able to raise their own abuse ceiling. Same posture as `trust_tier`,
-- `category`, `featured`.
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations. This file is committed for
-- history; a HUMAN applies the SQL below per environment (psql/retool). CI /
-- deploy does NOT run it.
--
-- ADDITIVE + NON-BREAKING:
--   - Two nullable columns, so existing rows and existing INSERTs (which don't
--     mention them) are unaffected — NULL = "no override", the default state for
--     every app.
--   - No index: both are read per-row on an already primary-key-filtered
--     `findUnique` (and then cached in-process), never used as a filter predicate.
--   - `IF NOT EXISTS` makes the apply idempotent (re-runnable, safe online).
--   - CHECK constraints keep a hand-written value positive. The reader
--     (`normalizeCapOverride`) independently ignores non-positive values and
--     clamps absurd ones, so the constraints are defence-in-depth, not the only
--     guard — but they stop the bad value getting in at all.
--
-- ⚠️ ORDERING: apply this BEFORE (or with) the deploy that reads the columns.
-- If the code ships first, the cap resolver's row read raises, and it falls back
-- to the STRICTEST tier — i.e. the pre-change ceilings. Degraded, never uncapped.

ALTER TABLE "app_blocks"
  ADD COLUMN IF NOT EXISTS "spend_cap_buzz_per_day" INTEGER,
  ADD COLUMN IF NOT EXISTS "spend_velocity_max_gens" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_blocks_spend_cap_buzz_per_day_positive'
  ) THEN
    ALTER TABLE "app_blocks"
      ADD CONSTRAINT "app_blocks_spend_cap_buzz_per_day_positive"
      CHECK ("spend_cap_buzz_per_day" IS NULL OR "spend_cap_buzz_per_day" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_blocks_spend_velocity_max_gens_positive'
  ) THEN
    ALTER TABLE "app_blocks"
      ADD CONSTRAINT "app_blocks_spend_velocity_max_gens_positive"
      CHECK ("spend_velocity_max_gens" IS NULL OR "spend_velocity_max_gens" > 0);
  END IF;
END
$$;
