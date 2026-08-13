-- ============================================================
-- App Listing COLLABORATORS — RE-KEY, **STEP B of 2**: CREATE the listing-keyed tables.
-- ============================================================
-- 🔴 RUN THIS **AFTER** THE CODE DEPLOY. Its partner, STEP A
-- (`20260811160000_rekey_app_collaborators_step_a_drop_block_keyed`), runs **BEFORE**.
--
-- THE SEQUENCE, in full (STEP A's banner carries the reasoning):
--     1. apply STEP A  → the block-keyed tables are dropped; the CURRENTLY DEPLOYED code
--                        sees PG 42P01 and degrades to owner-only (swallowed by
--                        `safeCollaboratorQuery`). Nothing surfaces.
--     2. deploy        → the new listing-keyed code goes out. Still no tables, still
--                        42P01, still swallowed. The feature is INERT, not broken.
--     3. apply STEP B  → this file. The tables appear and the feature turns on.
--
-- 🔴 APPLYING THIS FILE **BEFORE** THE DEPLOY RE-OPENS THE WINDOW THE SPLIT CLOSED, in
-- mirror image: the OLD deployed code would then read `app_block_id` off a table that
-- only has `app_listing_id` → PG 42703 `column ... does not exist` → `isMissingTableError`
-- refuses column errors on purpose → the error propagates and the public listing-detail
-- read 500s. Order is not a nicety here; it is the entire reason there are two files.
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
-- To undo STEP B: `DROP TABLE IF EXISTS "app_ownership_transfers", "app_ownership_events",
-- "app_collaborators";` — safe ONLY while they are still empty, which is the case for as
-- long as no invite has been sent. Once a seat exists, dropping destroys it; take a dump
-- of the three tables first. Dropping them returns the deployed code to the 42P01 path,
-- i.e. inert-and-owner-only, NOT broken — so this rollback does not require a code
-- rollback.
--
-- 🔴 To go all the way back to the block-keyed world, THE ORDER IS LOAD-BEARING and is
-- the reverse of the intuitive one:
--   1. DROP these listing-keyed tables (the statement above). Both code versions then
--      see 42P01, which `safeCollaboratorQuery` swallows — inert for old AND new code.
--   2. Roll the code deploy back.
--   3. Re-apply `20260810140000_app_listing_collaborators`.
-- Rolling the CODE back FIRST re-opens the window this split exists to eliminate:
-- block-keyed code against the `app_listing_id` column raises 42703, which
-- `isMissingTableError` deliberately refuses, so the public listing-detail read 500s.
-- 🔴 It also does not self-correct — every statement in `20260810140000` is
-- `IF NOT EXISTS`, so re-applying it while these tables still exist emits "already
-- exists, skipping" and leaves the key column as `app_listing_id`. Step 1 is what makes
-- step 3 do anything at all.
--
-- Idempotent: every CREATE is IF NOT EXISTS, so a re-run on an already-re-keyed schema
-- is a no-op.

-- ------------------------------------------------------------
-- 1. app_collaborators
-- ------------------------------------------------------------
-- Keyed to app_listings — the store-facing parent of BOTH kinds.
--
-- 🔴 A SEAT BELONGS TO A **PARENT** LISTING, NEVER TO A SHADOW REVISION
-- (`revision_of_id IS NOT NULL`). `applyApprovedRevision` DELETES the shadow on
-- approve, and this FK is ON DELETE CASCADE — so a seat that landed on a shadow would
-- vanish the moment a moderator approved the revision, silently and with no error. A
-- SQL CHECK cannot express this (a row-level CHECK cannot see another row's
-- `revision_of_id`), so it is enforced in the service: `inviteCollaborator` refuses a
-- shadow outright, and `resolveListingAccess` resolves a shadow to its parent before
-- ever looking a seat up. Both directions are pinned in
-- `app-collaborator.shadow-hazard.test.ts`.
--
-- CASCADE on both FKs (unlike the audit table below): a seat is a live capability, not
-- a historical record. If the listing is deleted there is nothing to edit; if the user
-- is deleted the seat must not survive as a dangling grant.
CREATE TABLE IF NOT EXISTS "app_collaborators" (
  "app_listing_id"   TEXT    NOT NULL REFERENCES "app_listings"("id") ON DELETE CASCADE,
  "user_id"          INTEGER NOT NULL REFERENCES "User"("id")         ON DELETE CASCADE,
  -- Capability role. 'editor' is the only value written today; TEXT (not an enum)
  -- so adding a role needs no migration. What an 'editor' may actually DO is derived
  -- from the listing's KIND, not stored here — see `capabilitiesForKind`.
  "role"             TEXT    NOT NULL DEFAULT 'editor',
  -- 🔴 CONSENT: only 'accepted' confers ANY capability and only 'accepted' is ever
  -- publicly visible. 'pending'/'rejected' are inert.
  "status"           TEXT    NOT NULL DEFAULT 'pending',
  -- Public-byline opt-in (immediate-apply, no mod review). Safe to apply
  -- immediately BECAUSE it lives here: applyApprovedRevision's offsite branch
  -- copies app_listings scalars from the shadow onto the parent, so the same flag
  -- stored as an app_listings column would be clobbered by a later approve. This row
  -- is outside both branches' copy sets.
  "displayed"        BOOLEAN NOT NULL DEFAULT true,
  "invited_by"       INTEGER NOT NULL REFERENCES "User"("id")         ON DELETE CASCADE,
  -- Re-invite notification throttle key. NULL = never notified.
  "last_notified_at" TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "responded_at"     TIMESTAMPTZ,

  PRIMARY KEY ("app_listing_id", "user_id"),

  CONSTRAINT "app_collaborators_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT "app_collaborators_role_check"
    CHECK ("role" IN ('editor'))
);

-- "which listings may this user edit" — the hot path (resolveAccessibleListingIds,
-- run on every gated proc for a non-owner).
CREATE INDEX IF NOT EXISTS "app_collaborators_user_status_idx"
  ON "app_collaborators" ("user_id", "status");
-- "who is on this listing" — the owner roster + the public byline read.
CREATE INDEX IF NOT EXISTS "app_collaborators_listing_status_idx"
  ON "app_collaborators" ("app_listing_id", "status");
-- FK index so a User delete (hot path) does not seq-scan on the inviter side.
CREATE INDEX IF NOT EXISTS "app_collaborators_invited_by_idx"
  ON "app_collaborators" ("invited_by");

-- ------------------------------------------------------------
-- 2. app_ownership_events  (append-only audit trail)
-- ------------------------------------------------------------
-- Mirrors app_listing_moderation_events' survivability posture: EVERY FK is
-- NULLABLE + SET NULL so an event outlives the listing, the actor and the target. The
-- denormalized "slug" keeps the row self-describing once the listing is gone.
CREATE TABLE IF NOT EXISTS "app_ownership_events" (
  "id"             TEXT PRIMARY KEY,                                            -- aoe_<ULID>
  "app_listing_id" TEXT    REFERENCES "app_listings"("id") ON DELETE SET NULL,
  "slug"           TEXT    NOT NULL,
  "action"         TEXT    NOT NULL,
  "actor_user_id"  INTEGER REFERENCES "User"("id")         ON DELETE SET NULL,
  "target_user_id" INTEGER REFERENCES "User"("id")         ON DELETE SET NULL,
  "metadata"       JSONB,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_ownership_events_action_check"
    CHECK ("action" IN (
      'invite', 'accept', 'reject', 'remove', 'leave', 'display',
      'transfer_initiated', 'transfer_accepted', 'transfer_cancelled'
    ))
);

CREATE INDEX IF NOT EXISTS "app_ownership_events_listing_idx"
  ON "app_ownership_events" ("app_listing_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "app_ownership_events_actor_idx"
  ON "app_ownership_events" ("actor_user_id", "created_at" DESC);

-- ------------------------------------------------------------
-- 3. app_ownership_transfers
-- ------------------------------------------------------------
-- One in-flight transfer per LISTING, enforced by the PARTIAL UNIQUE index below.
CREATE TABLE IF NOT EXISTS "app_ownership_transfers" (
  "id"             TEXT PRIMARY KEY,                                        -- aot_<ULID>
  "app_listing_id" TEXT    NOT NULL REFERENCES "app_listings"("id") ON DELETE CASCADE,
  -- Snapshot of the owner at initiate time. Re-asserted in-tx at accept, so a
  -- transfer initiated by someone who has since lost the listing cannot complete.
  "from_user_id"   INTEGER NOT NULL REFERENCES "User"("id")         ON DELETE CASCADE,
  "to_user_id"     INTEGER NOT NULL REFERENCES "User"("id")         ON DELETE CASCADE,
  "status"         TEXT    NOT NULL DEFAULT 'pending',
  -- Hard expiry, enforced as a read-time predicate in the ACCEPT path — no
  -- sweeper job is required for CORRECTNESS (a sweeper would only tidy rows).
  "expires_at"     TIMESTAMPTZ NOT NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "responded_at"   TIMESTAMPTZ,

  CONSTRAINT "app_ownership_transfers_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')),
  -- A self-transfer is meaningless and would make the accept path a no-op that
  -- still emits an audit event.
  CONSTRAINT "app_ownership_transfers_not_self_check"
    CHECK ("from_user_id" <> "to_user_id")
);

-- 🔴 THE one-in-flight-transfer GUARD. Prisma cannot express a partial unique
-- index, so this lives ONLY here — the service relies on its P2002 to close the
-- read-then-write race between two concurrent initiateTransfer calls.
CREATE UNIQUE INDEX IF NOT EXISTS "app_ownership_transfers_one_pending_per_listing"
  ON "app_ownership_transfers" ("app_listing_id")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "app_ownership_transfers_listing_status_idx"
  ON "app_ownership_transfers" ("app_listing_id", "status");
-- "transfers awaiting MY acceptance" — the recipient's inbox read.
CREATE INDEX IF NOT EXISTS "app_ownership_transfers_to_status_idx"
  ON "app_ownership_transfers" ("to_user_id", "status");
