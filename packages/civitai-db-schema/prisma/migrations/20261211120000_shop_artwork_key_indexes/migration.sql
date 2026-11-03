-- Apply by hand, BEFORE the deploy: `assertClientImageUrlsUsable` looks these keys up on every
-- image create. Without the indexes the code is still correct, only each lookup scans the table.
-- Each expression must stay identical to `keyIn` in src/server/services/image-url-ownership.ts.
--
-- CONCURRENTLY cannot run inside a transaction, so run each statement on its own. A cancelled build
-- leaves an invalid index under its name, which IF NOT EXISTS then skips. After applying, check
-- pg_index.indisvalid; if false, DROP INDEX CONCURRENTLY and run it again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Cosmetic_data_url_key_idx" ON "Cosmetic"
  ((substring(replace(translate(lower("data"->>'url'), E'\t\r\n', ''), '%2d', '-') from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')));
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CosmeticShopItem_meta_coverUrl_key_idx" ON "CosmeticShopItem"
  ((substring(replace(translate(lower("meta"->>'coverUrl'), E'\t\r\n', ''), '%2d', '-') from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')));
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ItemDefinition_imageUrl_key_idx" ON "ItemDefinition"
  ((substring(replace(translate(lower("imageUrl"), E'\t\r\n', ''), '%2d', '-') from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')));
