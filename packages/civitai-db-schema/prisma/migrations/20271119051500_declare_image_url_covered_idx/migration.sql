-- Declares an index that already exists in prod but was absent from the schema. Nothing to apply
-- there; this exists so a rebuilt-from-schema database gets it too. The auth session producer finds an
-- image by the upload key `User.image` names (`ownImageNamedByUserImage`), one probe of this index per
-- session; without it that lookup walks the user's images.
--
-- CONCURRENTLY cannot run inside a transaction block; run this statement on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Image_url_covered_idx" ON "Image" USING btree ("url") INCLUDE ("id", "hideMeta");
