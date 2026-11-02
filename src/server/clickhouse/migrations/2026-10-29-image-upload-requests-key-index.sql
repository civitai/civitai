-- Image upload requests: a skip index on `key`. Apply MANUALLY, BEFORE the code that reads it by
-- key deploys. The table is ordered by (userId, time), so a lookup by key alone would read every
-- granule without it. Confirm with
--   SELECT name, type FROM system.data_skipping_indices
--   WHERE database = 'default' AND table = 'imageUploadRequests'
-- which must list `key_bf`.

ALTER TABLE default.imageUploadRequests
  ADD INDEX IF NOT EXISTS key_bf key TYPE bloom_filter(0.01) GRANULARITY 1;

ALTER TABLE default.imageUploadRequests MATERIALIZE INDEX key_bf;
