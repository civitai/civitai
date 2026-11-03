-- App Blocks: cross-app storage imports — the per-source consent ledger.
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. Order relative to the code is free: the service treats a missing table or column
-- as "nobody has granted anything".
--
-- Additive and idempotent. Bounded by lock_timeout (the foreign keys lock the two referenced
-- tables); re-run the file on a timeout.

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

DO $$
BEGIN
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'app_storage_import_grants'
      AND column_name IN ('collections', 'access')
  ) <> 2 THEN
    RAISE EXCEPTION 'app_storage_import_grants exists without the collections and access columns (an earlier draft of this migration): drop it and re-run';
  END IF;
END
$$;

-- The source-side FK's cascade, and "who reaches this app's data", read by source.
CREATE INDEX IF NOT EXISTS "app_storage_import_grants_source_idx"
  ON "app_storage_import_grants"("source_app_block_id");
