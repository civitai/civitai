-- ============================================================
-- App Listing COLLABORATORS — editor seats, ownership audit trail, transfers
-- ============================================================
-- Adds three ADDITIVE tables:
--   1. app_collaborators        — the consent-gated editor seat (+ byline opt-in)
--   2. app_ownership_events     — append-only audit trail of every seat/ownership action
--   3. app_ownership_transfers  — an in-flight owner→recipient ownership transfer
--
-- Nothing existing is altered: no column is added to app_blocks, app_listings,
-- oauth_clients or block_buzz_attributions, and no existing row is touched.
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
-- error instead. So deploying the code before applying this migration changes
-- nothing observable; it does not 500 the app-listing pages.
--
-- Idempotent: IF NOT EXISTS guards throughout, so a manual re-run is a no-op.
-- All three tables are brand-new and EMPTY — no meaningful lock, no backfill.

-- ------------------------------------------------------------
-- 1. app_collaborators
-- ------------------------------------------------------------
-- Keyed to app_blocks (NOT app_listings): ownership is canonically
-- oauth_clients.user_id reached via app_blocks.app_id, and app_listings.user_id
-- is a denormalized copy that a shadow-revision approve can rewrite.
--
-- CASCADE on both FKs (unlike the audit table below): a seat is a live
-- capability, not a historical record. If the app is deleted there is nothing
-- to edit; if the user is deleted the seat must not survive as a dangling grant.
CREATE TABLE IF NOT EXISTS "app_collaborators" (
  "app_block_id"     TEXT    NOT NULL REFERENCES "app_blocks"("id") ON DELETE CASCADE,
  "user_id"          INTEGER NOT NULL REFERENCES "User"("id")       ON DELETE CASCADE,
  -- Capability role. 'editor' is the only value written today; TEXT (not an enum)
  -- so adding a role needs no migration.
  "role"             TEXT    NOT NULL DEFAULT 'editor',
  -- 🔴 CONSENT: only 'accepted' confers ANY capability and only 'accepted' is ever
  -- publicly visible. 'pending'/'rejected' are inert.
  "status"           TEXT    NOT NULL DEFAULT 'pending',
  -- Public-byline opt-in (immediate-apply, no mod review). Safe to apply
  -- immediately BECAUSE it lives here: applyApprovedRevision's offsite branch
  -- copies app_listings scalars from the shadow onto the parent, so the same flag
  -- stored as an app_listings column would be clobbered by a later approve.
  "displayed"        BOOLEAN NOT NULL DEFAULT true,
  "invited_by"       INTEGER NOT NULL REFERENCES "User"("id")       ON DELETE CASCADE,
  -- Re-invite notification throttle key. NULL = never notified.
  "last_notified_at" TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "responded_at"     TIMESTAMPTZ,

  PRIMARY KEY ("app_block_id", "user_id"),

  CONSTRAINT "app_collaborators_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT "app_collaborators_role_check"
    CHECK ("role" IN ('editor'))
);

-- "which apps may this user edit" — the hot path (resolveAccessibleAppBlockIds,
-- run on every gated proc for a non-owner).
CREATE INDEX IF NOT EXISTS "app_collaborators_user_status_idx"
  ON "app_collaborators" ("user_id", "status");
-- "who is on this app" — the owner roster + the public byline read.
CREATE INDEX IF NOT EXISTS "app_collaborators_app_status_idx"
  ON "app_collaborators" ("app_block_id", "status");
-- FK index so a User delete (hot path) does not seq-scan on the inviter side.
CREATE INDEX IF NOT EXISTS "app_collaborators_invited_by_idx"
  ON "app_collaborators" ("invited_by");

-- ------------------------------------------------------------
-- 2. app_ownership_events  (append-only audit trail)
-- ------------------------------------------------------------
-- Mirrors app_listing_moderation_events' survivability posture: EVERY FK is
-- NULLABLE + SET NULL so an event outlives the app, the actor and the target. The
-- denormalized "slug" keeps the row self-describing once the app is gone.
CREATE TABLE IF NOT EXISTS "app_ownership_events" (
  "id"             TEXT PRIMARY KEY,                                        -- aoe_<ULID>
  "app_block_id"   TEXT    REFERENCES "app_blocks"("id") ON DELETE SET NULL,
  "slug"           TEXT    NOT NULL,
  "action"         TEXT    NOT NULL,
  "actor_user_id"  INTEGER REFERENCES "User"("id")       ON DELETE SET NULL,
  "target_user_id" INTEGER REFERENCES "User"("id")       ON DELETE SET NULL,
  "metadata"       JSONB,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_ownership_events_action_check"
    CHECK ("action" IN (
      'invite', 'accept', 'reject', 'remove', 'leave', 'display',
      'transfer_initiated', 'transfer_accepted', 'transfer_cancelled'
    ))
);

CREATE INDEX IF NOT EXISTS "app_ownership_events_app_idx"
  ON "app_ownership_events" ("app_block_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "app_ownership_events_actor_idx"
  ON "app_ownership_events" ("actor_user_id", "created_at" DESC);

-- ------------------------------------------------------------
-- 3. app_ownership_transfers
-- ------------------------------------------------------------
-- One in-flight transfer per app, enforced by the PARTIAL UNIQUE index below.
CREATE TABLE IF NOT EXISTS "app_ownership_transfers" (
  "id"           TEXT PRIMARY KEY,                                    -- aot_<ULID>
  "app_block_id" TEXT    NOT NULL REFERENCES "app_blocks"("id") ON DELETE CASCADE,
  -- Snapshot of the owner at initiate time. Re-asserted in-tx at accept, so a
  -- transfer initiated by someone who has since lost the app cannot complete.
  "from_user_id" INTEGER NOT NULL REFERENCES "User"("id")       ON DELETE CASCADE,
  "to_user_id"   INTEGER NOT NULL REFERENCES "User"("id")       ON DELETE CASCADE,
  "status"       TEXT    NOT NULL DEFAULT 'pending',
  -- Hard expiry, enforced as a read-time predicate in the ACCEPT path — no
  -- sweeper job is required for CORRECTNESS (a sweeper would only tidy rows).
  "expires_at"   TIMESTAMPTZ NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "responded_at" TIMESTAMPTZ,

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
CREATE UNIQUE INDEX IF NOT EXISTS "app_ownership_transfers_one_pending_per_app"
  ON "app_ownership_transfers" ("app_block_id")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "app_ownership_transfers_app_status_idx"
  ON "app_ownership_transfers" ("app_block_id", "status");
-- "transfers awaiting MY acceptance" — the recipient's inbox read.
CREATE INDEX IF NOT EXISTS "app_ownership_transfers_to_status_idx"
  ON "app_ownership_transfers" ("to_user_id", "status");
