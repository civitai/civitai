-- ============================================================
-- App Blocks: cross-app storage imports — the per-source consent ledger
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database).
-- A human runs this file against the main civitai database, dev first, then production.
--
-- ORDER RELATIVE TO THE CODE IS FREE. The table is marked no-type in `schema.full.prisma`, and
-- every read and write goes through raw SQL in
-- `src/server/services/apps/storage-import-grant.service.ts`, which treats a missing table
-- (42P01) as "nobody has granted anything": an import answers `consent_required`, and granting
-- one is refused with a message saying it is not available yet. Nothing else changes.
--
-- One row = the viewer allowed the CONSUMER app to reach their data in the SOURCE app, through
-- the imports the consumer's approved manifest declares (`storage.imports`). It is written only
-- by the prompted consent (`blocks.grantScopes` with `apps:storage:import`) and deleted by the
-- viewer's revoke (`blocks.revokeStorageImport`) — a revoke is a DELETE, there is no history.
-- The `apps:storage:import` entry in `app_user_scope_grants` says the viewer consented to the
-- scope; these rows say which source apps that consent covered, so a later version that adds a
-- source needs a fresh prompt.
--
-- ADDITIVE ONLY: one new table, three foreign keys (all ON DELETE CASCADE, so deleting the user
-- or either app removes the grant), one CHECK, one index. Idempotent.

CREATE TABLE IF NOT EXISTS "app_storage_import_grants" (
    "user_id" INTEGER NOT NULL,
    "consumer_app_block_id" TEXT NOT NULL,
    "source_app_block_id" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_storage_import_grants_pkey"
      PRIMARY KEY ("user_id", "consumer_app_block_id", "source_app_block_id"),
    CONSTRAINT "app_storage_import_grants_not_self"
      CHECK ("consumer_app_block_id" <> "source_app_block_id"),
    CONSTRAINT "app_storage_import_grants_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "app_storage_import_grants_consumer_fkey"
      FOREIGN KEY ("consumer_app_block_id") REFERENCES "app_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "app_storage_import_grants_source_fkey"
      FOREIGN KEY ("source_app_block_id") REFERENCES "app_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The source-side FK's cascade, and "who reaches this app's data", read by source.
CREATE INDEX IF NOT EXISTS "app_storage_import_grants_source_idx"
  ON "app_storage_import_grants"("source_app_block_id");
