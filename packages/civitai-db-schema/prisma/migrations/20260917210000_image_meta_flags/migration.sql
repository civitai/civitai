-- Two meta-derived booleans the feed service filters on (`withMeta`, `fromPlatform`). It cannot
-- derive them itself: `Image.meta` is deliberately outside the replication column list, being the
-- largest column on the table. A separate narrow table is what carries them instead of columns on
-- "Image" — a STORED generated column rewrites all 446 GB under ACCESS EXCLUSIVE.
CREATE TABLE IF NOT EXISTS "ImageMetaFlags" (
  "imageId" INTEGER PRIMARY KEY,
  "hasMeta" BOOLEAN NOT NULL,
  "onSite" BOOLEAN NOT NULL
);

-- `hideMeta` is replicated on its own and applied downstream, so it is deliberately not folded in
-- here: a row hidden and then unhidden would otherwise need this table rewritten to recover.
-- The onSite rule is `imageOnSiteSql()` in src/server/utils/image-onsite.ts; the two must agree or
-- the feed and the search index answer `fromPlatform` differently.
CREATE OR REPLACE FUNCTION image_meta_flags_upsert()
RETURNS TRIGGER AS $$
DECLARE has_meta BOOLEAN; on_site BOOLEAN;
BEGIN
  has_meta := NEW.meta IS NOT NULL AND jsonb_typeof(NEW.meta) <> 'null';
  on_site := has_meta
    AND NEW.meta->>'civitaiResources' IS NOT NULL
    AND NOT (NEW.meta ? 'Version')
    AND (NOT (NEW.meta ? 'Model') OR (NEW.meta->>'Model') LIKE 'urn:air:%');

  INSERT INTO "ImageMetaFlags" ("imageId", "hasMeta", "onSite")
  VALUES (NEW.id, has_meta, on_site)
  ON CONFLICT ("imageId") DO UPDATE
    SET "hasMeta" = EXCLUDED."hasMeta", "onSite" = EXCLUDED."onSite"
    WHERE "ImageMetaFlags"."hasMeta" IS DISTINCT FROM EXCLUDED."hasMeta"
       OR "ImageMetaFlags"."onSite" IS DISTINCT FROM EXCLUDED."onSite";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- lock_timeout because CREATE TRIGGER takes ACCESS EXCLUSIVE on "Image": better to fail fast than
-- to queue behind a long transaction and block every write to the table.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS trg_image_meta_flags ON "Image";
CREATE TRIGGER trg_image_meta_flags
  AFTER INSERT OR UPDATE OF meta ON "Image"
  FOR EACH ROW
  EXECUTE FUNCTION image_meta_flags_upsert();
COMMIT;

-- Rows for images deleted later are left behind: every consumer reaches this table through a join
-- from "Image", and a foreign key would have to validate against all 115M rows to be added.

-- Existing images are loaded by /api/admin/temp/backfill-image-meta-flags (batched by id).
