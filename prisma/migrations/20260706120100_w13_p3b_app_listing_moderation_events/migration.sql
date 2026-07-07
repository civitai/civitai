-- ============================================================
-- App Store Listings (W13) — P3b off-site moderation: app_listing_moderation_events
-- ============================================================
-- Immutable, append-only audit trail of every moderator action on an off-site
-- listing (delist / relist / claim / purge / report-resolve / report-dismiss).
-- Dedicated table (do NOT overload app_listing_publish_requests) — mirrors the
-- site ModActivity audit pattern. See
-- claudedocs/app-blocks-p3b-delist-claim-scope-2026-07-06.md.
--
-- DARK/INERT: no code writes this table until P3b PR3 ships, so applying it ahead
-- of / independent of the code deploy is a no-op (like the P0 tables).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy). This
-- file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- Idempotent: IF NOT EXISTS guards so a manual re-run is a no-op. Indexes on a
-- brand-new EMPTY table — no meaningful lock.
--
-- The app_listing_id FK is NULLABLE + SET NULL so an event SURVIVES a later
-- hard-delete (purge) of the listing; the denormalized "slug" snapshot keeps the
-- event self-describing once the listing row is gone.

CREATE TABLE IF NOT EXISTS "app_listing_moderation_events" (
  "id"              TEXT PRIMARY KEY,                           -- alme_<ULID>
  -- Nullable + SET NULL so the audit event outlives a listing purge.
  "app_listing_id"  TEXT REFERENCES "app_listings"("id") ON DELETE SET NULL,
  -- Denormalized snapshot so the event is self-describing after a purge.
  "slug"            TEXT NOT NULL,
  -- The acting moderator. CASCADE on GDPR user-delete.
  "actor_user_id"   INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "action"          TEXT NOT NULL,
  -- Mod-supplied rationale / ownership-verification note.
  "reason"          TEXT,
  "detail"          TEXT,
  -- Structured before/after state (e.g. {"status":"approved"} / {"userId":123}).
  "before"          JSONB,
  "after"           JSONB,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_listing_mod_events_action_check"
    CHECK ("action" IN ('delist', 'relist', 'claim', 'purge', 'report-resolve', 'report-dismiss'))
);

-- Per-listing moderation history.
CREATE INDEX IF NOT EXISTS "app_listing_mod_events_listing_idx"
  ON "app_listing_moderation_events" ("app_listing_id", "created_at" DESC);
-- Per-moderator activity.
CREATE INDEX IF NOT EXISTS "app_listing_mod_events_actor_idx"
  ON "app_listing_moderation_events" ("actor_user_id", "created_at" DESC);
