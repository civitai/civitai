-- App Blocks batch private upload (OPEN_MEDIA_UPLOAD_BATCH): one row per batch a viewer confirmed,
-- the moderator audit record of which consumer blobs it created. Read and written only by
-- media-upload-batch.service.ts (main app) and the moderator app's upload-batch audit page.
--
-- ORDER: either. Before it is applied the batch path refuses every batch with "batch media upload
-- is not available yet" and uploads nothing; the single-file upload paths never read it.
--
-- MANUAL APPLY, per writable env:
--   1. Dry run: this file inside BEGIN; ... ROLLBACK;
--   2. Apply.
--   3. Scoped drift check (read-only role), see packages/civitai-db-schema/src/schema-drift/README.md.
--
-- GRANTS, A REQUIRED STEP. Unless new tables are granted to the app roles automatically in this
-- environment, run after this file, with the environment's actual role names:
--   GRANT SELECT, INSERT, UPDATE ON "app_block_upload_batches" TO <app_write_role>;
--   GRANT USAGE ON SEQUENCE "app_block_upload_batches_id_seq" TO <app_write_role>;
--   GRANT SELECT ON "app_block_upload_batches" TO <moderator_read_role>, <app_read_role>;
-- and check each with has_table_privilege('<role>', '"app_block_upload_batches"', '<privilege>').
--
-- ROLLBACK: DROP TABLE "app_block_upload_batches"; (the batch path then refuses again).
CREATE TABLE IF NOT EXISTS "app_block_upload_batches" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "app_block_id" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "block_id" TEXT NOT NULL,
  "version" TEXT,
  "item_count" INTEGER NOT NULL CHECK ("item_count" > 0),
  "total_bytes" BIGINT NOT NULL CHECK ("total_bytes" >= 0),
  "presign_count" INTEGER NOT NULL DEFAULT 0,
  "presign_counts" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "blob_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ(6) NOT NULL
);

-- Added after the table was first drafted; a no-op where the CREATE above made it.
ALTER TABLE "app_block_upload_batches"
  ADD COLUMN IF NOT EXISTS "presign_counts" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

CREATE INDEX IF NOT EXISTS "app_block_upload_batches_user_created_idx"
  ON "app_block_upload_batches" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "app_block_upload_batches_app_created_idx"
  ON "app_block_upload_batches" ("app_block_id", "created_at" DESC);
