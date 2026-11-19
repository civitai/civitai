-- Hat Turf: team stickers on other people's images, and each player's sticker supply.
--
-- Apply order, all before the deploy that ships Hat Turf:
--   1. this file (Postgres). New tables only; nothing existing is rewritten or locked.
--   2. the ClickHouse ALTER below. ADD COLUMN with a constant default is metadata-only.
--   3. the deploy. It writes the `players` column on every ledger insert, so an insert against a
--      table without it fails and its points are lost.

CREATE TABLE IF NOT EXISTS "EventTurfSticker" (
  "id"          BIGSERIAL PRIMARY KEY,
  "event"       TEXT NOT NULL,
  "imageId"     INTEGER NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE,
  "userId"      INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "team"        TEXT NOT NULL,
  "cosmeticId"  INTEGER NOT NULL,
  "data"        JSONB NOT NULL DEFAULT '{}',
  "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "removedAt"   TIMESTAMPTZ(3),
  "removedById" INTEGER
);

-- One sticker per player per image for the whole event, removed or not: a moderator removal is final.
CREATE UNIQUE INDEX IF NOT EXISTS "EventTurfSticker_event_imageId_userId_key"
  ON "EventTurfSticker" ("event", "imageId", "userId");

-- The live stickers of an event, by image, oldest first: the leader and the earliest stickerers
-- credited are read from this, per image on placement and for the whole event on reconcile.
CREATE INDEX IF NOT EXISTS "EventTurfSticker_event_live_idx"
  ON "EventTurfSticker" ("event", "imageId", "createdAt", "id")
  WHERE "removedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "EventTurfSticker_event_userId_idx"
  ON "EventTurfSticker" ("event", "userId");

CREATE TABLE IF NOT EXISTS "EventTurfStock" (
  "event"      TEXT NOT NULL,
  "userId"     INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "stock"      DOUBLE PRECISION NOT NULL,
  "refilledAt" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("event", "userId")
);

-- ClickHouse (apply separately, against the default database):
--
-- The players a turf action credits, each as if their sticker were a hat on the image. Empty on a
-- hat's row, which credits its ownerId as before.
--
-- ALTER TABLE default.event_point_events
--   ADD COLUMN IF NOT EXISTS players Array(Int32) DEFAULT [];
