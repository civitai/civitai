-- Creator Shop takedowns for the takedown CDN sync. Apply by hand BEFORE the deploy: it blocks the
-- deploy. Without the table every image create fails site-wide (`assertClientImageUrlsUsable` reads
-- it: posts, avatars, covers, collections, comics, shop artwork, article content), as do image deletes
-- and article saves (`shopArtworkUrls`), and the CDN takedown sync, reconciler and persist retry stall
-- for every url, not only shop ones.
--
-- One row per artwork key a takedown stopped serving, kept after the listing or its cosmetic is
-- deleted: a takedown is permanent, so the url stays taken down through every later re-check.
-- `userId` is the owner the takedown named (the cosmetic's creator, or the lister). `id` keys the
-- row's persist retry, one per key.
CREATE TABLE IF NOT EXISTS "ImageCdnShopTakedown" (
  id             integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  url            text NOT NULL,
  "shopItemId"   integer NOT NULL,
  "userId"       integer,
  "takenDownAt"  timestamp(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (url, "shopItemId")
);
