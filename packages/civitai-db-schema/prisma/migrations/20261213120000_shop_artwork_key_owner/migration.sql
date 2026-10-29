-- Apply by hand BEFORE the deploy: every Creator Shop artwork save reads and writes this table, so
-- without it those saves fail.
--
-- One row per upload key saved as shop artwork whose issue record named its owner. `userId` is the
-- user the record named, not the saver.
CREATE TABLE IF NOT EXISTS "ShopArtworkKeyOwner" (
  key           text PRIMARY KEY,
  "userId"      integer NOT NULL,
  "recordedAt"  timestamp(3) NOT NULL DEFAULT now()
);
