-- App Blocks document store: content-level columns on `appdata.doc`. MANUAL-APPLY migration.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically.
--
-- WHAT IT ADDS: a shared document's content level, in the site's NsfwLevel bit values (PG 1,
--   PG-13 2, R 4, X 8, XXX 16, Blocked 32; one bit per document, never a mask), and its rating
--   state. All nullable, no default and no backfill:
--   - `level`          the rated level (build 3, the rater, sets it; a write clears it);
--   - `rating_status`  'pending' (written since its last rating), 'rated', or 'overridden';
--                      NULL = never rated (a document written before this existed, or while
--                      `app-blocks-shared-doc-levels` was off);
--   - `override_level`, `override_by`, `override_at`
--                      a moderator's level, which wins over `level` while set;
--   - `rated_at`       when `level` was last set.
--   - `rated_version`, `override_version`
--                      the document `version` the rating and the override were given for. A
--                      rating or override counts only while it matches the document's current
--                      `version` (every rewrite of the body bumps it: a put, a schema migration);
--                      otherwise the document reads as pending, so a rating never outlives the
--                      content it rated, whoever or whatever rewrote it.
--   Read by the store only while the per-app flag `app-blocks-shared-doc-levels` is on
--   (`doc-levels.ts`); with it off no statement names these columns.
--
-- 🔴 ROLLOUT ORDER: this migration, then the backfill that rates existing documents (build 3),
--   then the flag. With the flag on, a document whose status is NULL or 'pending' is hidden from
--   every viewer but its author, and a statement naming a missing column fails, so turning the
--   flag on before this is applied fails those requests outright rather than silently.
--
-- Same lock discipline as `20261106130000_appdata_doc_schema_major.sql`: catalog-only ALTERs
--   (nullable, no default) under a 1s lock_timeout, below the store's own 3s. A CHECK constraint
--   added NOT VALID takes no table scan; nothing existing can violate it (every row is NULL).
--   If the ALTER times out, re-run it. The existing grants and row-level policies cover the new
--   columns.
--
-- IDEMPOTENT: IF NOT EXISTS, and each constraint is added only when absent from `appdata.doc`.
--   ROLLBACK: the sibling `20261116120000_appdata_doc_levels.down.sql`.

BEGIN;
SET LOCAL lock_timeout = '1s';
ALTER TABLE appdata.doc
  ADD COLUMN IF NOT EXISTS level integer,
  ADD COLUMN IF NOT EXISTS rating_status text,
  ADD COLUMN IF NOT EXISTS override_level integer,
  ADD COLUMN IF NOT EXISTS override_by integer,
  ADD COLUMN IF NOT EXISTS override_at timestamptz,
  ADD COLUMN IF NOT EXISTS rated_at timestamptz,
  ADD COLUMN IF NOT EXISTS rated_version integer,
  ADD COLUMN IF NOT EXISTS override_version integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'doc_level_bit' AND conrelid = 'appdata.doc'::regclass) THEN
    ALTER TABLE appdata.doc ADD CONSTRAINT doc_level_bit
      CHECK (level IS NULL OR level IN (1, 2, 4, 8, 16, 32)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'doc_override_level_bit' AND conrelid = 'appdata.doc'::regclass) THEN
    ALTER TABLE appdata.doc ADD CONSTRAINT doc_override_level_bit
      CHECK (override_level IS NULL OR override_level IN (1, 2, 4, 8, 16, 32)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'doc_rating_status' AND conrelid = 'appdata.doc'::regclass) THEN
    ALTER TABLE appdata.doc ADD CONSTRAINT doc_rating_status
      CHECK (rating_status IS NULL OR rating_status IN ('pending', 'rated', 'overridden')) NOT VALID;
  END IF;
END $$;
COMMIT;
