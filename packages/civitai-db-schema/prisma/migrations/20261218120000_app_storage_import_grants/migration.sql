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
-- the import the consent prompt showed them: `collections` and `access` are exactly what it
-- displayed for that source. It is written only by the prompted consent (`blocks.grantScopes`
-- with `apps:storage:import`, which refuses when the displayed imports differ from the approved
-- manifest's) and deleted by the viewer's revoke (`blocks.revokeStorageImport`), by a re-consent
-- that no longer names the source, and by the mint when the consumer no longer imports from it.
-- A revoke is a DELETE, there is no history. The `apps:storage:import` entry in
-- `app_user_scope_grants` says the viewer consented to the scope; these rows say what that
-- consent covered, so a later version that adds a source, imports another collection or turns
-- `read` into `readwrite` needs a fresh prompt (a narrower one does not).
--
-- ADDITIVE ONLY: one new table, three foreign keys (all ON DELETE CASCADE, so deleting the user
-- or either app removes the grant), two CHECKs, one index. Idempotent. A brand-new table, so
-- the locks are on the two referenced tables only (SHARE ROW EXCLUSIVE for the foreign keys):
-- bounded by lock_timeout, so a busy table makes this fail fast rather than queue writes behind
-- it. Re-run the file on a timeout. (An earlier draft of this file, without `collections` and
-- `access`, was never applied anywhere; `IF NOT EXISTS` would keep that shape if it had been.)

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "app_storage_import_grants" (
    "user_id" INTEGER NOT NULL,
    "consumer_app_block_id" TEXT NOT NULL,
    "source_app_block_id" TEXT NOT NULL,
    -- The source's collections the prompt named, and whether it said the app can change them.
    "collections" TEXT[] NOT NULL,
    "access" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_storage_import_grants_pkey"
      PRIMARY KEY ("user_id", "consumer_app_block_id", "source_app_block_id"),
    CONSTRAINT "app_storage_import_grants_not_self"
      CHECK ("consumer_app_block_id" <> "source_app_block_id"),
    CONSTRAINT "app_storage_import_grants_access_check"
      CHECK ("access" IN ('read', 'readwrite')),
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
