-- ============================================================
-- App Listing COLLABORATORS — RE-KEY, **STEP A of 2**: DROP the block-keyed tables.
-- ============================================================
-- 🔴 RUN THIS **BEFORE** THE CODE DEPLOY. Its partner, STEP B
-- (`20260811170000_rekey_app_collaborators_step_b_create_listing_keyed`), runs
-- **AFTER**. The order is the whole point of the split — see "WHY TWO FILES" below.
--
-- SUPERSEDES 20260810140000_app_listing_collaborators, which created these same three
-- tables keyed on `app_blocks(id)`:
--   1. app_collaborators        — the consent-gated editor seat (+ byline opt-in)
--   2. app_ownership_events     — append-only audit trail of every seat/ownership action
--   3. app_ownership_transfers  — an in-flight owner→recipient ownership transfer
--
-- WHY RE-KEY. `app_blocks` is the ON-SITE runtime record. An OFF-SITE listing
-- (external-link / OAuth-connect) has NO backing AppBlock in production today — every
-- off-site row carries `app_listings.app_block_id IS NULL` — so a block-keyed seat was
-- structurally unable to exist for one of the store's two kinds. `app_listings` is the
-- store-facing parent of BOTH kinds, so keying the seat there is what makes
-- collaborators reach off-site listings.
--
-- ------------------------------------------------------------
-- 🔴 WHY TWO FILES — the DEPLOY WINDOW this ordering removes
-- ------------------------------------------------------------
-- A single DROP+CREATE migration cannot be applied atomically with a code deploy, so
-- there is always a window in which one side is ahead of the other. The question is only
-- WHICH error the code in that window sees:
--
--   * OLD (block-keyed) tables PRESENT + NEW code deployed
--       → a seat read asks for `app_listing_id` on a table that has `app_block_id`
--       → PG **42703** `column "app_listing_id" does not exist`
--       → `isMissingTableError` (app-access.service.ts) deliberately REFUSES column
--         errors — a half-applied schema must surface, not degrade to a silent zero —
--         so `safeCollaboratorQuery` RETHROWS. It reaches `getListingDetail` →
--         `loadDisplayedCollaboratorChips` with no try/catch above it, and the public
--         listing-detail read 500s. 🔴 THIS IS THE WINDOW WE ARE REMOVING.
--
--   * NO collaborator tables at all + EITHER code version deployed
--       → PG **42P01** `relation ... does not exist`
--       → `isMissingTableError` returns true → `safeCollaboratorQuery` degrades to
--         "no collaborators", i.e. exactly today's owner-only behaviour. No error
--         surfaces anywhere.
--
-- So the safe sequence is to spend the whole deploy window in the SECOND state:
--
--     1. apply STEP A (this file)  → tables gone; the CURRENTLY DEPLOYED code degrades
--                                    cleanly to owner-only (42P01, swallowed)
--     2. deploy the code           → new code, still no tables; still 42P01, still
--                                    swallowed. The feature is INERT, not broken.
--     3. apply STEP B              → listing-keyed tables appear; the feature turns on
--
-- Every intermediate state is a 42P01 state. There is no instant at which any deployed
-- code can raise 42703, which is what made the single-file version unsafe in BOTH
-- directions (the reverse order — SQL first, deploy later — broke the OLD code the same
-- way).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai CNPG
-- nvme0 DB does NOT auto-apply migrations (there is no `prisma migrate deploy` in any
-- deploy path). This file is committed for HISTORY ONLY; a HUMAN applies the SQL below
-- per environment (psql / retool). CI and deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- ------------------------------------------------------------
-- 🔴 ROLLBACK DIRECTION
-- ------------------------------------------------------------
-- To undo STEP A: re-apply `20260810140000_app_listing_collaborators` verbatim. It is
-- the file that created the block-keyed tables and every statement in it is
-- `IF NOT EXISTS`, so re-running it restores the pre-STEP-A schema exactly. Nothing is
-- lost, because the guard below refuses to run at all unless the tables are EMPTY.
-- Undoing the whole re-key = roll back the code deploy, then re-apply
-- `20260810140000_app_listing_collaborators`, then drop the STEP B tables (STEP B's own
-- file documents that direction).
--
-- Idempotent: the guard tolerates already-absent tables and every DROP is IF EXISTS, so
-- a re-run on an already-dropped schema is a no-op.

-- ------------------------------------------------------------
-- 0. 🔴 THE EMPTINESS GUARD — executable, not prose.
-- ------------------------------------------------------------
-- This whole migration is a DROP + re-CREATE rather than an ALTER + backfill, and that
-- is safe for exactly ONE reason: all three tables are EMPTY in every environment
-- (measured 2026-08-11: prod 0/0/0, dev clone 0/0/0). The predecessor migration is
-- applied but the feature has never been exercised, so there is nothing to preserve.
--
-- 🔴 That fact is a MEASUREMENT, and a measurement decays. If a row appears between the
-- measurement and the apply, this file would destroy it silently — so the precondition
-- is RE-CHECKED AT APPLY TIME, by the database, and the apply ABORTS if it no longer
-- holds. A comment saying "these are empty" cannot do that; this can. If it fires, the
-- correct shape is an ALTER + backfill, not this file.
--
-- `to_regclass` + EXECUTE so a table that is already gone is skipped rather than being
-- a parse-time failure.
DO $$
DECLARE
  t     text;
  n     bigint;
  found text[] := ARRAY[]::text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['app_collaborators', 'app_ownership_events', 'app_ownership_transfers']
  LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
      IF n > 0 THEN
        found := found || format('%s=%s', t, n);
      END IF;
    END IF;
  END LOOP;

  IF array_length(found, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'REFUSING TO DROP: the block-keyed collaborator tables are NOT empty (%). This migration is a DROP + re-CREATE and would destroy those rows. Use an ALTER + backfill instead.',
      array_to_string(found, ', ');
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Drop the block-keyed predecessors.
-- ------------------------------------------------------------
-- Order is irrelevant (no FK points at these three), but they are dropped together so a
-- partial apply cannot leave a block-keyed table beside a listing-keyed one. CASCADE is
-- deliberately NOT used: nothing should depend on these, and if something does, the
-- apply must fail loudly rather than silently drop it.
DROP TABLE IF EXISTS "app_ownership_transfers";
DROP TABLE IF EXISTS "app_ownership_events";
DROP TABLE IF EXISTS "app_collaborators";
