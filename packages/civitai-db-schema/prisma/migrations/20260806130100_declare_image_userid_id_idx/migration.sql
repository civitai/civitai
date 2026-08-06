-- Declares an index that already exists in prod but was absent from the schema. Nothing to apply
-- there; this exists so a rebuilt-from-schema database gets it too. `getImagesByUserIdForModeration`
-- (the CSAM report picker) orders by id within a user, which this serves as an index scan backward
-- with no sort node — without it that unpaginated query becomes an external sort.
--
-- CONCURRENTLY cannot run inside a transaction block; run this statement on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "image_userid_id_idx" ON "Image" ("userId", "id");
