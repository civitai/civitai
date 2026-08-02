-- ============================================================
-- App Blocks — PER-APP generation SPEND TIER + cap OVERRIDE
-- ============================================================
-- The per-app aggregate generation guardrail (app-spend-cap.service.ts) used to
-- enforce ONE global daily-Buzz + velocity ceiling on EVERY app. Its own header
-- flagged that as the prerequisite for opening App Blocks to non-moderators: a
-- modestly popular app would brush the 120-gens/60s velocity ceiling (~2
-- gens/sec AGGREGATE across all its viewers) and its users would start getting
-- abuse rejections.
--
-- This migration adds the SPEND axis:
--
--   spend_tier              the moderator-assigned spend class. Drives the
--                           app's default {daily Buzz, velocity} ceilings.
--   spend_cap_buzz_per_day  per-app OVERRIDE on the daily ceiling. NULL = none.
--   spend_velocity_max_gens per-app OVERRIDE on the velocity ceiling. NULL = none.
--
--   effective = override (per field) ELSE spend_tier's limits ELSE strictest,
--               finally clamped by the deploy-time BLOCK_APP_SPEND_* globals.
--
-- 🔴 WHY A DEDICATED `spend_tier` AND NOT `trust_tier`.
-- `trust_tier` is a BROWSER-ISOLATION decision: it gates the iframe `sandbox`
-- token allowlist (specifically whether `allow-same-origin` may combine with
-- `allow-scripts`) and whether `render_mode` may be inline/hybrid. It says
-- nothing about money. Deriving spend ceilings from it would mean a moderator
-- granting a RENDERING capability silently granted a 5x money ceiling.
--
-- That was not hypothetical. On 2026-07-31 this database already held:
--
--     trust_tier | apps | approved | suspended
--     internal   |    3 |        0 |         3
--     unverified |   18 |        9 |         9
--
-- Three rows were tiered `internal` for RENDERING, long before a spend cap
-- existed. Reading them as spend grants would have raised them from
-- 5,000,000/120 to 25,000,000/3,000 the moment this shipped, with no moderator
-- action. `spend_tier` defaults to 'standard' — whose limits are byte-identical
-- to the pre-change global ceilings — so all 21 existing rows, INCLUDING those
-- three, keep exactly today's ceilings.
--
-- 🔴 PLATFORM-CONTROLLED. All three columns are written only by the mod-gated
-- `BlockRegistry.setAppSpendCapConfig` (moderatorProcedure). None of them appear
-- in the manifest schema, in a publisher-facing tRPC input, or in the
-- /api/v1/developer/block-manifests payload — a developer must not be able to
-- raise their own abuse ceiling.
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations. This file is committed for
-- history; a HUMAN applies the SQL below per environment (psql/retool). CI /
-- deploy does NOT run it.
--
-- ⚠️ ORDERING: apply this BEFORE the deploy that reads the columns, not after.
-- Prisma enumerates every scalar in the model when a query gives no `select`,
-- so with the code deployed and the columns missing, every such `appBlock`
-- query raises P2022 — including four in the moderator approve flow
-- (publish-request.service.ts), the developer manifest endpoint (500) and the
-- build callback (swallowed: a lost `currentVersionDeployedAt` write means the
-- app never appears in the store). The narrow, `select`-ed cap resolver itself
-- degrades safely to the strictest tier (= today's ceilings), but the rest of
-- the app does not. Same precedent as migration
-- 20260629120000_add_appblock_external_url.
--
-- ADDITIVE + NON-BREAKING:
--   - `spend_tier` is NOT NULL with a DEFAULT, so on PG 11+ this is a
--     metadata-only rewrite-free ALTER and every existing row reads back as
--     'standard' immediately. Existing INSERTs that don't mention it still work.
--   - The two override columns are nullable — NULL = "no override", the default
--     state for every app.
--   - No index: all three are read per-row on an already primary-key-filtered
--     `findUnique` (and then cached in-process), never used as a filter predicate.
--   - `IF NOT EXISTS` makes the apply idempotent (re-runnable, safe online).
--
-- 🔴 THE CHECK CONSTRAINTS MATCH THE CODE BOUNDS EXACTLY.
-- An INTEGER column accepts up to 2,147,483,647. A bare `> 0` check would let a
-- hand-written 2000000000 in; the reader then clamps it to 1e9 at enforcement
-- while the moderator read surface reports the RAW 2000000000 — one value, three
-- different numbers. The bounds below are the same numbers as
-- APP_CAP_OVERRIDE_MAX_DAILY_BUZZ / APP_CAP_OVERRIDE_MAX_VELOCITY_GENS in
-- app-cap-limits.constants.ts (and as the zod input schema), so an out-of-range
-- value is REJECTED at the database instead of silently reinterpreted. This
-- matters precisely because this DB is edited by hand.

ALTER TABLE "app_blocks"
  ADD COLUMN IF NOT EXISTS "spend_tier" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS "spend_cap_buzz_per_day" INTEGER,
  ADD COLUMN IF NOT EXISTS "spend_velocity_max_gens" INTEGER;

DO $$
BEGIN
  -- spend_tier must be one of the known spend classes. Deliberately DISJOINT
  -- from the trust_tier vocabulary ('unverified'/'verified'/'internal') so that
  -- copying one column into the other fails loudly here rather than resolving to
  -- a plausible-looking wrong ceiling. (The reader independently falls back to
  -- the strictest limits for any unrecognised value, so an older pod reading a
  -- newer tier degrades safely rather than uncapping.)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_blocks_spend_tier_known'
  ) THEN
    ALTER TABLE "app_blocks"
      ADD CONSTRAINT "app_blocks_spend_tier_known"
      CHECK ("spend_tier" IN ('standard', 'trusted', 'platform'));
  END IF;

  -- Bounds are APP_CAP_OVERRIDE_MAX_DAILY_BUZZ (1e9) — identical to the zod
  -- schema and to the read-time clamp.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_blocks_spend_cap_buzz_per_day_bounds'
  ) THEN
    ALTER TABLE "app_blocks"
      ADD CONSTRAINT "app_blocks_spend_cap_buzz_per_day_bounds"
      CHECK (
        "spend_cap_buzz_per_day" IS NULL
        OR ("spend_cap_buzz_per_day" >= 1 AND "spend_cap_buzz_per_day" <= 1000000000)
      );
  END IF;

  -- Bounds are APP_CAP_OVERRIDE_MAX_VELOCITY_GENS (100_000).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_blocks_spend_velocity_max_gens_bounds'
  ) THEN
    ALTER TABLE "app_blocks"
      ADD CONSTRAINT "app_blocks_spend_velocity_max_gens_bounds"
      CHECK (
        "spend_velocity_max_gens" IS NULL
        OR ("spend_velocity_max_gens" >= 1 AND "spend_velocity_max_gens" <= 100000)
      );
  END IF;
END
$$;
