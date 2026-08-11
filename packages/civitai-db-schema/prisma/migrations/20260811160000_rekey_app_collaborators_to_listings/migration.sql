-- ============================================================
-- App Listing COLLABORATORS — RE-KEY from app_blocks to app_listings
-- ============================================================
-- SUPERSEDES 20260810140000_app_listing_collaborators. That migration created the
-- same three tables keyed on `app_blocks(id)`:
--   1. app_collaborators        — the consent-gated editor seat (+ byline opt-in)
--   2. app_ownership_events     — append-only audit trail of every seat/ownership action
--   3. app_ownership_transfers  — an in-flight owner→recipient ownership transfer
--
-- WHY RE-KEY. `app_blocks` is the ON-SITE runtime record. An OFF-SITE listing
-- (external-link / OAuth-connect) has NO backing AppBlock at all — every off-site row
-- in production carries `app_listings.app_block_id IS NULL` — so a block-keyed seat is
-- structurally unable to exist for one of the store's two kinds. `app_listings` is the
-- store-facing parent of BOTH kinds, so keying the seat there is what makes
-- collaborators reach off-site listings. It also removes a hop: every gate in this
-- feature is a listing-shaped question that previously had to walk back to the block.
--
-- ⚠️ THIS IS A DROP + CREATE, NOT A DATA MIGRATION — and that is SAFE for exactly one
-- reason: all three tables are EMPTY in every environment (verified 2026-08-11: prod
-- 0/0/0, dev clone 0/0/0). The predecessor migration is applied but the feature has
-- never been exercised, so there is nothing to preserve and nothing to back-fill. If a
-- row ever appears before this is applied, STOP — this file would destroy it, and the
-- correct shape is then an ALTER + backfill, not this.
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (there is no `prisma migrate
-- deploy` in any deploy path). This file is committed for HISTORY ONLY; a HUMAN
-- applies the SQL below per environment (psql / retool). CI and deploy do NOT
-- run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- 🔴 THE FEATURE IS INERT UNTIL THIS IS APPLIED, BY CONSTRUCTION. Every read of
-- these tables is wrapped in `safeCollaboratorQuery` (app-access.service.ts),
-- which catches the Postgres "relation does not exist" error (Prisma P2021 /
-- PG 42P01) and degrades to "no collaborators" — i.e. exactly today's
-- owner-only behaviour. The WRITE paths (invite / transfer) surface a friendly
-- error instead. 🔴 NOTE THE WINDOW THIS MIGRATION OPENS THAT THE PREDECESSOR DID
-- NOT: between deploying this code and applying this SQL, the OLD (block-keyed)
-- tables still exist, so a read does NOT hit 42P01 — it hits `column
-- "app_listing_id" does not exist` (42703), which `isMissingTableError`
-- deliberately does NOT swallow (a column error is a HALF-APPLIED schema and must
-- surface). Apply this migration in the SAME maintenance step as the deploy.
--
-- Idempotent: the DROPs are IF EXISTS and every CREATE is IF NOT EXISTS, so a manual
-- re-run is a no-op on an already-re-keyed schema.

-- ------------------------------------------------------------
-- 0. Drop the block-keyed predecessors.
-- ------------------------------------------------------------
-- Order is irrelevant (no FK points at these three), but they are dropped together so
-- a partial apply cannot leave a block-keyed table beside a listing-keyed one. CASCADE
-- is deliberately NOT used: nothing should depend on these, and if something does, the
-- apply must fail loudly rather than silently drop it.
DROP TABLE IF EXISTS "app_ownership_transfers";
DROP TABLE IF EXISTS "app_ownership_events";
DROP TABLE IF EXISTS "app_collaborators";

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
